import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { TiktokService } from './tiktok.service';
import { TiktokResponse } from './tiktok.client';
import { UpstreamHeadersInterceptor } from './upstream-headers.interceptor';
import { SessionService } from '../session/session.service';
import { RateLimiter } from '../common/http/rate-limiter';
import { HttpClient } from '../common/http/http-client';
import { NumericIdPipe } from '../common/pipes/numeric-id.pipe';
import { CONFIG, type AppConfig } from '../config/configuration';
import {
  CountQueryDto,
  PageQueryDto,
  RawRequestDto,
  SearchQueryDto,
  UserDetailQueryDto,
  UserPageQueryDto,
} from './dto/tiktok.dto';

@Controller('tiktok')
@UseInterceptors(UpstreamHeadersInterceptor)
export class TiktokController {
  constructor(private readonly tiktok: TiktokService) {}

  @Get('user/detail')
  userDetail(@Query() query: UserDetailQueryDto): Promise<TiktokResponse> {
    return this.tiktok.getUserDetail(query);
  }

  @Get('user/posts')
  userPosts(@Query() query: UserPageQueryDto): Promise<TiktokResponse> {
    return this.tiktok.getPostItemList(query);
  }

  @Get('user/followers')
  userFollowers(@Query() { secUid, count, cursor }: UserPageQueryDto): Promise<TiktokResponse> {
    return this.tiktok.getUserList(secUid, 'followers', count, cursor);
  }

  @Get('user/following')
  userFollowing(@Query() { secUid, count, cursor }: UserPageQueryDto): Promise<TiktokResponse> {
    return this.tiktok.getUserList(secUid, 'following', count, cursor);
  }

  @Get('user/liked')
  userLiked(@Query() query: UserPageQueryDto): Promise<TiktokResponse> {
    return this.tiktok.getLikedItemList(query);
  }

  @Get('user/playlists')
  userPlaylists(@Query() query: UserPageQueryDto): Promise<TiktokResponse> {
    return this.tiktok.getUserPlaylists(query);
  }

  @Get('trending')
  trending(@Query() { count }: CountQueryDto): Promise<TiktokResponse> {
    return this.tiktok.getRecommendItemList(count);
  }

  @Get('video/:itemId')
  video(@Param('itemId', NumericIdPipe) itemId: string): Promise<TiktokResponse> {
    return this.tiktok.getItemDetail(itemId);
  }

  @Get('video/:itemId/related')
  relatedVideos(@Param('itemId', NumericIdPipe) itemId: string): Promise<TiktokResponse> {
    return this.tiktok.getRelatedItemList(itemId);
  }

  @Get('video/:itemId/comments')
  comments(
    @Param('itemId', NumericIdPipe) awemeId: string,
    @Query() { count, cursor }: PageQueryDto,
  ): Promise<TiktokResponse> {
    return this.tiktok.getCommentList({ awemeId, count, cursor });
  }

  @Get('video/:itemId/comments/:commentId/replies')
  commentReplies(
    @Param('itemId', NumericIdPipe) awemeId: string,
    @Param('commentId', NumericIdPipe) commentId: string,
    @Query() { count, cursor }: PageQueryDto,
  ): Promise<TiktokResponse> {
    return this.tiktok.getCommentReplyList({ awemeId, commentId, count, cursor });
  }

  @Get('playlist/:mixId')
  playlist(@Param('mixId', NumericIdPipe) mixId: string): Promise<TiktokResponse> {
    return this.tiktok.getMixDetail(mixId);
  }

  @Get('playlist/:mixId/videos')
  playlistVideos(
    @Param('mixId', NumericIdPipe) mixId: string,
    @Query() { count, cursor }: PageQueryDto,
  ): Promise<TiktokResponse> {
    return this.tiktok.getMixItemList({ mixId, count, cursor });
  }

  @Get('music/:musicId')
  music(@Param('musicId', NumericIdPipe) musicId: string): Promise<TiktokResponse> {
    return this.tiktok.getMusicDetail(musicId);
  }

  @Get('music/:musicId/videos')
  musicVideos(
    @Param('musicId', NumericIdPipe) musicId: string,
    @Query() { count, cursor }: PageQueryDto,
  ): Promise<TiktokResponse> {
    return this.tiktok.getMusicItemList({ musicId, count, cursor });
  }

  @Get('challenge/:tag')
  challenge(@Param('tag') tag: string): Promise<TiktokResponse> {
    return this.tiktok.getChallengeDetail(tag);
  }

  @Get('challenge/:tag/videos')
  challengeVideos(
    @Param('tag') challengeId: string,
    @Query() { count, cursor }: PageQueryDto,
  ): Promise<TiktokResponse> {
    return this.tiktok.getChallengeItemList({ challengeId, count, cursor });
  }

  @Get('search/general')
  searchGeneral(@Query() query: SearchQueryDto): Promise<TiktokResponse> {
    return this.tiktok.searchGeneral(query);
  }

  @Get('search/users')
  searchUsers(@Query() query: SearchQueryDto): Promise<TiktokResponse> {
    return this.tiktok.searchUsers(query);
  }

  @Post('raw')
  @HttpCode(200)
  raw(@Body() body: RawRequestDto): Promise<TiktokResponse> {
    return this.tiktok.raw(body);
  }
}

@Controller('internal')
export class InternalController {
  constructor(
    private readonly tiktok: TiktokService,
    private readonly session: SessionService,
    private readonly rateLimiter: RateLimiter,
    private readonly http: HttpClient,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('health')
  async health(@Req() req: Request & { id?: string }): Promise<unknown> {
    const probe = await this.tiktok.probe();
    const impersonator = this.http.impersonatorStatus;
    const chromeHandshake = impersonator.inUse === 'tls';

    return {
      status: probe.ok ? 'ok' : 'degraded',
      transport: {
        configured: this.config.tiktok.transport,
        inUse: impersonator.inUse,
        backend: impersonator.backend,
        chromeHandshake,
        clientIdentifier: chromeHandshake ? this.config.tiktok.tlsClientIdentifier : null,
        backends: impersonator.backends,
        note: chromeHandshake
          ? `Chrome ClientHello via ${impersonator.backend}`
          : 'undici, Node/OpenSSL ClientHello. Six API paths refuse this handshake; ' +
            'see backends for why the Chrome-shaped options were rejected.',
      },
      session: this.describeSession(),
      upstream: probe.ok
        ? {
            reachable: true,
            logId: probe.detail?.logId,
            elapsedMs: probe.detail?.elapsedMs,
            signMs: probe.detail?.signature.ms,
            ticketGuardResult: probe.detail?.ticketGuardResult,
          }
        : { reachable: false, error: probe.error },
      pacing: {
        minIntervalMs: this.config.tiktok.minRequestIntervalMs,
        maxConcurrent: this.config.tiktok.maxConcurrentRequests,
        inFlight: this.rateLimiter.inFlight,
        queued: this.rateLimiter.pending,
        retryOnThrottle: this.config.tiktok.retryOnThrottle,
        throttleBackoffBaseMs: this.config.tiktok.throttleBackoffBaseMs,
      },
      config: {
        origin: this.config.tiktok.origin,
        region: this.config.tiktok.region,
        proxy: Boolean(this.config.tiktok.proxyUrl),
        timeoutMs: this.config.tiktok.timeoutMs,
        maxRetries: this.config.tiktok.maxRetries,
      },
      requestId: req.id,
    };
  }

  @Get('session')
  async currentSession(): Promise<unknown> {
    await this.session.get();
    return this.session.describe();
  }

  @Get('session-state')
  async sessionState(): Promise<unknown> {
    const response = await this.tiktok.getSessionState();
    return response.data;
  }

  @Post('session/reset')
  @HttpCode(200)
  resetSession(): { status: 'reset' } {
    this.session.invalidate('operator requested');
    return { status: 'reset' };
  }

  private describeSession(): unknown {
    try {
      return this.session.describe();
    } catch {
      return null;
    }
  }
}
