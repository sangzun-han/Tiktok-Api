import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { HttpClient } from '../common/http/http-client';
import { SessionService, SessionSnapshot } from '../session/session.service';
import {
  UpstreamBlockedError,
  UpstreamHttpError,
  UpstreamMalformedError,
  UpstreamRateLimitedError,
  UpstreamRejectedError,
  UpstreamThrottledError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
} from '../common/errors/tiktok-errors';
import { RateLimiter } from '../common/http/rate-limiter';
import { signRequest, DEFAULT_SDK_VERSION, DEFAULT_SCM_VERSION } from '../signer/tiktok-sign';

export type QueryValue =
  | string
  | number
  | boolean
  | undefined
  | null

  | ReadonlyArray<string | number>;

export interface TiktokRequest {
  path: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  referer?: string;
  method?: 'GET' | 'POST';
  body?: string;
  envCode?: number;
  ubCode?: number;
  keepEmpty?: string[];
  sign?: boolean;
  bare?: boolean;
  allowEmpty?: boolean;
  softBlockDetector?: (payload: unknown) => boolean;
  // Non-zero app status codes that still carry a usable payload.
  okStatusCodes?: number[];
}

export interface TiktokResponse<T = unknown> {
  status: number;
  logId?: string;
  data: T;
  raw: string;
  url: string;
  elapsedMs: number;
  attempts: number;
  ticketGuardResult?: number;
  signature: { applied: boolean; ms: number };
}

interface AttemptContext {
  session: SessionSnapshot;
  signedUrl: string;
  signatureMs: number;
  signatureApplied: boolean;
}

@Injectable()
export class TiktokClient {
  private readonly logger = new Logger(TiktokClient.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly http: HttpClient,
    private readonly session: SessionService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async request<T = unknown>(request: TiktokRequest): Promise<TiktokResponse<T>> {
    const attempts = this.config.tiktok.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let context: AttemptContext;
      try {
        context = await this.prepare(request);
      } catch (error) {
        throw error;
      }

      try {
        const response = await this.rateLimiter.run(() =>
          this.http.send(context.signedUrl, {
            method: request.method ?? 'GET',
            body: request.body,
            headers: this.buildHeaders(request, context),
          }),
        );

        if (response.status === 429) {
          this.rateLimiter.penalise(TiktokClient.retryAfterMs(response.headers) ?? this.config.tiktok.throttleBackoffBaseMs);
        }

        return this.interpret<T>(request, context, response.status, response.headers, response.body, response.elapsedMs, attempt);
      } catch (error) {
        lastError = error;

        if (!TiktokClient.isRetryable(error) || attempt === attempts) {
          throw TiktokClient.normaliseTransportError(error, context);
        }

        // The edge guard throttles per session, and a fresh session gets through right away.
        if (error instanceof UpstreamThrottledError && attempt === 1) {
          this.session.invalidate(`throttled on ${request.path}`);
        }

        const delay = TiktokClient.retryDelay(error, this.config, attempt);

        this.rateLimiter.penalise(delay);
        this.logger.warn(
          `Attempt ${attempt}/${attempts} for ${request.path} throttled/failed ` +
            `(${TiktokClient.message(error)}); retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw TiktokClient.normaliseTransportError(lastError, undefined);
  }

  async get<T = unknown>(
    path: string,
    query?: Record<string, QueryValue>,
    extra: Omit<TiktokRequest, 'path' | 'query' | 'method'> = {},
  ): Promise<TiktokResponse<T>> {
    return this.request<T>({ ...extra, path, query, method: 'GET' });
  }

  private async prepare(request: TiktokRequest): Promise<AttemptContext> {
    const session = await this.session.get();
    const origin = this.config.tiktok.origin;

    if (request.sign === false) {
      const pairs = this.buildPairs(request, session);
      const query = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      return {
        session,
        signedUrl: query ? `${origin}${request.path}?${query}` : `${origin}${request.path}`,
        signatureMs: 0,
        signatureApplied: false,
      };
    }

    const started = Date.now();
    const pairs = this.buildPairs(request, session);
    const signed = signRequest(pairs, {
      userAgent: this.config.tiktok.userAgent,
      msToken: session.msToken ?? '',
      sdkVersion: this.config.tiktok.signerSdkVersion ?? DEFAULT_SDK_VERSION,
      scmVersion: this.config.tiktok.signerScmVersion ?? DEFAULT_SCM_VERSION,
      envCode: request.envCode,
      ubCode: request.ubCode,
    });

    return {
      session,
      signedUrl: `${origin}${request.path}?${signed.query}`,
      signatureMs: Date.now() - started,
      signatureApplied: true,
    };
  }

  private static truncatedAppVersion(userAgent: string): string {
    const match = /Mozilla\/([\d.]+) \(([^;)]+)/.exec(userAgent);
    if (!match) return userAgent;
    return `${match[1]} (${match[2].trim().split(/\s+/)[0]})`;
  }

  private buildPairs(
    request: TiktokRequest,
    session: SessionSnapshot,
  ): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];

    if (!request.bare) {
      const common = this.commonParams(session);
      for (const [key, value] of Object.entries(common)) {
        if (value !== undefined && value !== null && value !== '') pairs.push([key, String(value)]);
      }
    }

    const keepEmpty = new Set(request.keepEmpty ?? []);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (value === '' && !keepEmpty.has(key)) continue;
      pairs.push([key, Array.isArray(value) ? value.join(',') : String(value)]);
    }

    if (
      !pairs.some(([key]) => key === 'clientABVersions') &&
      this.abVersionsPaths.has(request.path) &&
      session.abTestVersions
    ) {
      pairs.push(['clientABVersions', session.abTestVersions]);
    }

    return pairs;
  }

  private readonly abVersionsPaths = new Set<string>([
    '/api/challenge/item_list/',
    '/api/collection/item_list/',
    '/api/creator/item_list/',
    '/api/favorite/item_list/',
    '/api/following/item_list/',
    '/api/friends/item_list/',
    '/api/mix/item_list/',
    '/api/poi/item_list/',
    '/api/post/item_list/',
    '/api/post/item_list/v1/',
    '/api/question/item_list/',
    '/api/recommend/item_list/',
    '/api/topic/item_list/',
    '/api/user/collect/item_list/',
  ]);

  private commonParams(session: SessionSnapshot): Record<string, string> {
    const cfg = this.config.tiktok;
    const userAgentForQuery = cfg.userAgent;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const region = session.region || cfg.region;

    const params: Record<string, string> = {
      aid: String(cfg.appId),
      app_name: cfg.appName,
      app_language: cfg.language,
      device_platform: cfg.devicePlatform,
      device_id: session.webId,
      region,
      priority_region: region,
      language: cfg.language,
      WebIdLastTime: String(nowSeconds),
      channel: 'tiktok_web',
      cookie_enabled: 'true',
      os: 'mac',
      browser_language: cfg.browserLanguage,
      browser_name: 'Mozilla',
      browser_online: 'true',
      browser_platform: 'MacIntel',
      browser_version: TiktokClient.truncatedAppVersion(userAgentForQuery),
      focus_state: 'true',
      is_fullscreen: 'false',
      is_page_visible: 'true',
      history_len: '3',
      // A common MacBook viewport, matching the default User-Agent.
      screen_height: '1117',
      screen_width: '1728',
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webcast_language: cfg.language,
      referer: '',
      root_referer: `${cfg.origin}/`,
    };

    return params;
  }

  private buildHeaders(request: TiktokRequest, context: AttemptContext): Record<string, string> {
    const cfg = this.config.tiktok;
    const headers: Record<string, string> = {
      'User-Agent': cfg.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': `${cfg.language}-${cfg.region},${cfg.language};q=0.9`,
      'Accept-Encoding': 'gzip, deflate, br',
      Referer: request.referer ?? `${cfg.origin}/`,
      Origin: cfg.origin,
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      priority: 'u=1, i',
      Cookie: context.session.cookieHeader,
    };

    if (context.session.csrfToken) {
      headers['x-secsdk-csrf-token'] = context.session.csrfToken;
    }

    return { ...headers, ...(request.headers ?? {}) };
  }

  private interpret<T>(
    request: TiktokRequest,
    context: AttemptContext,
    status: number,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
    elapsedMs: number,
    attempt: number,
  ): TiktokResponse<T> {
    const raw = body.toString('utf8');
    const logId = TiktokClient.header(headers, 'x-tt-logid');
    const ticketGuardResult = TiktokClient.numericHeader(headers, 'tt-ticket-guard-result');
    const signature = { applied: context.signatureApplied, ms: context.signatureMs };
    const overloaded = TiktokClient.isOverloadResponse(status, raw);

    if (status === 429 || overloaded) {
      throw new UpstreamThrottledError(
        `TikTok throttled the request to ${request.path} (HTTP ${status}${overloaded ? ', overload-protect' : ''}).`,
        {
          url: context.signedUrl,
          logId,
          upstreamStatus: status,
          signed: signature.applied,
          body: raw.slice(0, 300),
          retryAfterMs: TiktokClient.retryAfterMs(headers),
        },
      );
    }

    if (status >= 500) {
      throw new UpstreamHttpError(
        `TikTok returned HTTP ${status} for ${request.path}.`,
        {
          url: context.signedUrl,
          logId,
          upstreamStatus: status,
          body: raw.slice(0, 500),
          signed: signature.applied,
          sessionAttached: Boolean(context.session.cookieHeader),
        },
      );
    }

    if (raw.length === 0) {
      if (request.allowEmpty) {
        return {
          status,
          logId,
          data: undefined as T,
          raw,
          url: context.signedUrl,
          elapsedMs,
          attempts: attempt,
          ticketGuardResult,
          signature,
        };
      }
      throw new UpstreamThrottledError(
        `TikTok answered HTTP ${status} with an empty body for ${request.path}` +
          (ticketGuardResult === 0 ? ' (tt-ticket-guard-result: 0).' : '.'),
        {
          url: context.signedUrl,
          logId,
          upstreamStatus: status,
          signed: signature.applied,
          sessionAttached: Boolean(context.session.cookieHeader),
          ticketGuardResult,
          orcas: TiktokClient.numericHeader(headers, 'tt_orcas_res'),
          msTokenPresent: Boolean(context.session.msToken),
          deviceIdFromPage: context.session.identityFromPage,
        },
      );
    }

    let data: T;
    const isJson =
      TiktokClient.header(headers, 'content-type')?.includes('json') === true ||
      raw.startsWith('{') ||
      raw.startsWith('[');

    if (!isJson) {
      const looksLikeChallenge = /wafchallengeid|_wafchallengeid|Please wait/i.test(raw);
      if (looksLikeChallenge) {
        throw new UpstreamBlockedError(
          `TikTok served a WAF challenge page instead of JSON for ${request.path}.`,
          {
            url: context.signedUrl,
            logId,
            upstreamStatus: status,
            body: raw.slice(0, 500),
            signed: signature.applied,
            ticketGuardResult,
          },
          'This egress IP has been flagged by the edge. A different network or a ' +
            'residential proxy (TIKTOK_PROXY_URL) is required.',
        );
      }
      if (status >= 400) {
        throw new UpstreamHttpError(
          `TikTok returned HTTP ${status} with a non-JSON body for ${request.path}.`,
          { url: context.signedUrl, logId, upstreamStatus: status, body: raw.slice(0, 500) },
        );
      }
      return {
        status,
        logId,
        data: raw as unknown as T,
        raw,
        url: context.signedUrl,
        elapsedMs,
        attempts: attempt,
        ticketGuardResult,
        signature,
      };
    }

    try {
      data = JSON.parse(raw) as T;
    } catch (error) {
      throw new UpstreamMalformedError(
        `TikTok returned a body that is not valid JSON for ${request.path}.`,
        {
          url: context.signedUrl,
          logId,
          upstreamStatus: status,
          body: raw.slice(0, 500),
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const envelope = data as Record<string, unknown>;
    const appStatus = TiktokClient.appStatusCode(envelope);
    if (appStatus !== undefined && appStatus !== 0 && !request.okStatusCodes?.includes(appStatus)) {
      const appMessage = TiktokClient.appStatusMessage(envelope);
      throw new UpstreamRejectedError(
        `TikTok rejected ${request.path} with status_code ${appStatus}${appMessage ? `: ${appMessage}` : '.'}`,
        {
          statusCode: appStatus,
          statusMessage: appMessage,
          url: context.signedUrl,
          logId,
          upstreamStatus: status,
          body: raw.slice(0, 500),
          signed: signature.applied,
        },
      );
    }

    if (request.softBlockDetector?.(data)) {
      const details = {
        url: context.signedUrl,
        logId,
        upstreamStatus: status,
        body: raw.slice(0, 500),
        signed: signature.applied,
        ticketGuardResult,
        orcas: TiktokClient.numericHeader(headers, 'tt_orcas_res'),
      };
      if (ticketGuardResult !== undefined) {
        throw new UpstreamThrottledError(
          `TikTok answered ${request.path} with an empty payload under its edge guard ` +
            `(tt-ticket-guard-result: ${ticketGuardResult}).`,
          details,
        );
      }
      throw new UpstreamBlockedError(
        `TikTok answered ${request.path} with a structurally valid but empty payload.`,
        details,
      );
    }

    return {
      status,
      logId,
      data,
      raw,
      url: context.signedUrl,
      elapsedMs,
      attempts: attempt,
      ticketGuardResult,
      signature,
    };
  }

  private static appStatusCode(envelope: Record<string, unknown>): number | undefined {
    const candidates = [envelope['status_code'], envelope['statusCode']];
    for (const candidate of candidates) {
      if (typeof candidate === 'number') return candidate;
      if (typeof candidate === 'string' && candidate.trim() !== '' && !Number.isNaN(Number(candidate))) {
        return Number(candidate);
      }
    }
    return undefined;
  }

  private static appStatusMessage(envelope: Record<string, unknown>): string | undefined {
    const candidates = [envelope['status_msg'], envelope['statusMessage'], envelope['message']];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    }
    return undefined;
  }

  static isOverloadResponse(status: number, raw: string): boolean {
    if (/overload-protect/i.test(raw)) return true;
    return status === 503 && raw.length === 0;
  }

  static retryAfterMs(headers: Record<string, string | string[] | undefined>): number | undefined {
    const raw = TiktokClient.header(headers, 'retry-after');
    if (!raw) return undefined;

    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
    return undefined;
  }

  private static isRetryable(error: unknown): boolean {
    if (error instanceof UpstreamThrottledError) return true;
    if (error instanceof UpstreamRateLimitedError) return true;
    if (error instanceof UpstreamHttpError) return true;
    if (error instanceof UpstreamTimeoutError) return true;
    if (error instanceof UpstreamUnreachableError) return true;
    return TiktokClient.isNetworkError(error);
  }

  private static retryDelay(error: unknown, config: AppConfig, attempt: number): number {
    const base =
      error instanceof UpstreamThrottledError || error instanceof UpstreamRateLimitedError
        ? config.tiktok.throttleBackoffBaseMs
        : config.tiktok.retryBaseDelayMs;

    const explicit = (error as { details?: { retryAfterMs?: number } })?.details?.retryAfterMs;
    if (typeof explicit === 'number' && explicit > 0) {
      return Math.min(explicit, 60_000);
    }
    return TiktokClient.backoff(base, attempt);
  }

  private static isNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const retryableCodes = [
      'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
      'ENOTFOUND', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    ];
    if (retryableCodes.some((c) => code === c)) return true;
    return /socket hang up|other side closed|timeout|timed out|fetch failed/i.test(error.message);
  }

  private static normaliseTransportError(
    error: unknown,
    context: AttemptContext | undefined,
  ): Error {
    if (error instanceof UpstreamThrottledError) return error;
    if (error instanceof UpstreamRateLimitedError) return error;
    if (error instanceof UpstreamHttpError) return error;
    if (error instanceof UpstreamBlockedError) return error;
    if (error instanceof UpstreamRejectedError) return error;

    const message = TiktokClient.message(error);
    const url = context?.signedUrl;

    if (/timeout|timed out|UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT/i.test(message)) {
      return new UpstreamTimeoutError(`TikTok did not respond in time: ${message}`, { url });
    }
    return new UpstreamUnreachableError(`Could not reach TikTok: ${message}`, { url });
  }

  private static backoff(base: number, attempt: number): number {
    const exponential = base * 2 ** (attempt - 1);
    const jitter = Math.random() * base;
    return Math.round(Math.min(exponential + jitter, 8_000));
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static header(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const value = headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private static numericHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): number | undefined {
    const raw = TiktokClient.header(headers, name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
