import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { TiktokClient, TiktokResponse, QueryValue } from './tiktok.client';
import {
  BadRequestError,
  UpstreamRejectedError,
} from '../common/errors/tiktok-errors';

export interface UserDetailInput {
  uniqueId?: string;
  secUid?: string;
}

export interface PaginatedInput {
  cursor?: string;
  count?: number;
}

export interface PostItemListInput extends PaginatedInput {
  secUid: string;
}

export interface CommentListInput extends PaginatedInput {
  awemeId: string;
}

export interface SearchInput {
  keyword: string;
  count?: number;
  offset?: string;
  searchId?: string;
}

export interface ChallengeItemListInput extends PaginatedInput {
  challengeId: string;
}

export interface MusicItemListInput extends PaginatedInput {
  musicId: string;
}

export interface CommentReplyListInput extends PaginatedInput {
  awemeId: string;
  commentId: string;
}

export interface MixItemListInput extends PaginatedInput {
  mixId: string;
}

export interface RawRequestInput {
  path: string;
  query?: Record<string, QueryValue>;
  referer?: string;
  method?: 'GET' | 'POST';
  body?: string;
  sign?: boolean;
  bare?: boolean;
  allowEmpty?: boolean;
}

const softBlocks = {
  userDetail: (payload: unknown): boolean => {
    if (!isRecord(payload) || !isRecord(payload.userInfo)) return false;
    const user = payload.userInfo.user;
    return isRecord(user) && Object.keys(user).length === 0;
  },

  itemDetail: (payload: unknown): boolean => {
    if (!isRecord(payload) || hasErrorStatus(payload)) return false;
    return payload.itemInfo === undefined;
  },

  emptyList: (payload: unknown): boolean => {
    if (!isRecord(payload)) return false;
    return Object.keys(payload).every((key) => BOOKKEEPING_KEYS.has(key));
  },
};

const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  'status_code',
  'statusCode',
  'log_pb',
]);

function challengeIdFrom(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.challengeInfo)) return null;
  const challenge = parsed.challengeInfo.challenge;
  if (!isRecord(challenge)) return null;
  const id = challenge.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// A non-zero statusCode is TikTok's own answer (e.g. 10204 = video not found), not a block.
function hasErrorStatus(payload: Record<string, unknown>): boolean {
  const code = payload.statusCode ?? payload.status_code;
  return typeof code === 'number' && code !== 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvelopeOnly(payload: unknown): boolean {
  return softBlocks.emptyList(payload);
}

// 2 = WebP covers.
const COVER_FORMAT = '2';

@Injectable()
export class TiktokService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly client: TiktokClient,
  ) {}

  async getUserDetail(input: UserDetailInput): Promise<TiktokResponse> {
    if (!input.uniqueId && !input.secUid) {
      throw new BadRequestError('user/detail requires either `uniqueId` or `secUid`.');
    }

    return this.client.get('/api/user/detail/', {
      secUid: input.secUid ?? '',
      uniqueId: input.uniqueId ?? '',
      from_page: 'user',
    }, {
      // TikTok wants both keys present, one of them empty. Sending only one fails.
      keepEmpty: ['secUid', 'uniqueId'],
      referer: input.uniqueId ? `${this.config.tiktok.origin}/@${input.uniqueId}` : undefined,
      softBlockDetector: softBlocks.userDetail,
    });
  }

  async getPostItemList(input: PostItemListInput): Promise<TiktokResponse> {
    return this.client.get('/api/post/item_list/', {
      secUid: input.secUid,
      cursor: input.cursor ?? '0',
      count: input.count ?? 30,
      coverFormat: COVER_FORMAT,
      needPinnedItemIds: 'true',
      locate_item_id: '',

      // 0 = default order, 1 = popular, 2 = oldest.
      post_item_list_request_type: '0',
    }, {
      softBlockDetector: isEnvelopeOnly,
      // This endpoint rejects the default envCode of 65.
      envCode: 64,
    });
  }

  async getMusicDetail(musicId: string): Promise<TiktokResponse> {
    return this.client.get('/api/music/detail/', { musicId });
  }

  async getSessionState(): Promise<TiktokResponse> {
    return this.client.get(
      '/passport/token/beat/web/',
      // Passport service uses its own app id.
      { device_platform: 'web', aid: '1459', scene: 'active' },
      { sign: false, bare: true, allowEmpty: true },
    );
  }

  async getUserList(
    secUid: string,
    scene: 'followers' | 'following',
    count = 30,
    cursor?: string,
  ): Promise<TiktokResponse> {
    return this.client.get('/api/user/list/', {
      secUid,
      count,

      // Paging walks backwards, so only minCursor moves.
      minCursor: cursor ?? '0',
      maxCursor: '0',
      // Scene ids from the web bundle: 67 = followers, 21 = following.
      scene: scene === 'followers' ? '67' : '21',
    }, {
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getItemDetail(itemId: string): Promise<TiktokResponse> {
    return this.client.get('/api/item/detail/', { itemId }, {
      referer: `${this.config.tiktok.origin}/`,
      softBlockDetector: softBlocks.itemDetail,
    });
  }

  async getRelatedItemList(itemId: string, count = 16): Promise<TiktokResponse> {
    return this.client.get('/api/related/item_list/', {
      itemID: itemId,
      count,
      coverFormat: 2,
      isNonPersonalized: false,
    }, {
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getCommentList(input: CommentListInput): Promise<TiktokResponse> {
    return this.client.get('/api/comment/list/', {
      aweme_id: input.awemeId,
      count: input.count ?? 20,
      cursor: input.cursor ?? '0',
      // Without these the endpoint returns an empty body.
      fromWeb: 1,
      enter_from: 'tiktok_web',
      current_region: this.config.tiktok.region,
    }, {
      referer: `${this.config.tiktok.origin}/`,
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getCommentReplyList(input: CommentReplyListInput): Promise<TiktokResponse> {
    // Pages hold 2-5 replies whatever `count` says, and has_more stays 0 even when more remain:
    // follow `cursor` until it reaches `total`.
    return this.client.get('/api/comment/list/reply/', {
      item_id: input.awemeId,
      comment_id: input.commentId,
      count: input.count ?? 20,
      cursor: input.cursor ?? '0',
    }, {
      referer: `${this.config.tiktok.origin}/`,
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getLikedItemList(input: PostItemListInput): Promise<TiktokResponse> {
    // Private likes come back as statusCode 0 with no itemList (check userInfo.user.openFavorite).
    return this.client.get('/api/favorite/item_list/', {
      secUid: input.secUid,
      cursor: input.cursor ?? '0',
      count: input.count ?? 30,
      coverFormat: COVER_FORMAT,
    }, {
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getUserPlaylists(input: PostItemListInput): Promise<TiktokResponse> {
    return this.client.get('/api/user/playlist/', {
      secUid: input.secUid,
      cursor: input.cursor ?? '0',
      count: input.count ?? 20,
    }, {
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getMixDetail(mixId: string): Promise<TiktokResponse> {
    return this.client.get('/api/mix/detail/', { mixId });
  }

  async getMixItemList(input: MixItemListInput): Promise<TiktokResponse> {
    return this.client.get('/api/mix/item_list/', {
      mixId: input.mixId,
      cursor: input.cursor ?? '0',
      count: input.count ?? 30,
      coverFormat: COVER_FORMAT,
    }, {
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getRecommendItemList(count = 30): Promise<TiktokResponse> {
    // The signed-out For You feed. No cursor, and back-to-back calls repeat most items.
    return this.client.get('/api/recommend/item_list/', {
      from_page: 'fyp',
      count,
      coverFormat: COVER_FORMAT,
    }, {
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getMusicItemList(input: MusicItemListInput): Promise<TiktokResponse> {
    return this.client.get('/api/music/item_list/', {
      musicID: input.musicId,
      cursor: input.cursor ?? '0',
      count: input.count ?? 30,
      coverFormat: COVER_FORMAT,
    }, {
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getChallengeItemList(input: ChallengeItemListInput): Promise<TiktokResponse> {
    const challengeID = await this.resolveChallengeId(input.challengeId);
    return this.client.get('/api/challenge/item_list/', {
      challengeID,
      count: input.count ?? 30,
      cursor: input.cursor ?? '0',
      fromWeb: 1,
    }, {
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async getChallengeDetail(challengeIdOrName: string): Promise<TiktokResponse> {
    const raw = challengeIdOrName.trim();
    // A numeric challengeName is read as a hashtag literally named "7551", not id 7551.
    const query = /^\d+$/.test(raw)
      ? { challengeId: raw }
      : { challengeName: raw.replace(/^#/, '') };
    return this.client.get('/api/challenge/detail/', query);
  }

  private async resolveChallengeId(challengeIdOrName: string): Promise<string> {
    const raw = challengeIdOrName.trim();
    if (/^\d+$/.test(raw)) return raw;

    const name = raw.replace(/^#/, '');
    if (!name) {
      throw new BadRequestError(
        'challengeId must be a numeric id or a hashtag name such as `cat` or `#cat`.',
      );
    }

    const detail = await this.getChallengeDetail(name);
    const challenge = challengeIdFrom(detail.raw);
    if (!challenge) {
      throw new UpstreamRejectedError(
        `No TikTok hashtag matches "${name}".`,
        { hashtag: name, upstreamStatus: detail.status },
      );
    }
    return challenge;
  }

  async searchGeneral(input: SearchInput): Promise<TiktokResponse> {
    return this.client.get('/api/search/general/full/', {
      keyword: input.keyword,
      count: input.count ?? 12,
      offset: input.offset ?? '0',
      // Pages after the first are ignored unless they carry the first page's search id.
      search_id: input.searchId,
      search_source: 'normal_search',
      query_type: 'general',
      is_filter_search: 0,
      from_group: 1,
    }, {
      referer: `${this.config.tiktok.origin}/search?q=${encodeURIComponent(input.keyword)}`,
      softBlockDetector: isEnvelopeOnly,
      // TikTok sometimes answers status_code 203 with a full page of results.
      okStatusCodes: [203],
    });
  }

  async searchUsers(input: SearchInput): Promise<TiktokResponse> {
    return this.client.get('/api/search/user/full/', {
      keyword: input.keyword,
      count: input.count ?? 12,
      // User search pages by `cursor` and ignores `offset`.
      cursor: input.offset ?? '0',
      search_id: input.searchId,
      search_source: 'normal_search',
    }, {
      referer: `${this.config.tiktok.origin}/search?q=${encodeURIComponent(input.keyword)}`,
      softBlockDetector: isEnvelopeOnly,
    });
  }

  async raw(input: RawRequestInput): Promise<TiktokResponse> {
    if (!input.path.startsWith('/')) {
      throw new BadRequestError('raw.path must begin with "/" and be origin-relative.');
    }
    if (input.path.startsWith('//')) {
      throw new BadRequestError('raw.path must not be protocol-relative.');
    }

    return this.client.request({
      path: input.path,
      query: input.query,
      headers: undefined,
      referer: input.referer,
      method: input.method ?? 'GET',
      body: input.body,
      sign: input.sign,
      bare: input.bare,
      allowEmpty: input.allowEmpty,
    });
  }

  async probe(): Promise<{ ok: boolean; detail: TiktokResponse | undefined; error?: string }> {
    try {
      const response = await this.searchGeneral({ keyword: 'a', count: 1 });
      return { ok: true, detail: response };
    } catch (error) {
      return { ok: false, detail: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
