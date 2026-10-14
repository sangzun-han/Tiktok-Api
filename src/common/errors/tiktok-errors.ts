import { HttpStatus } from '@nestjs/common';

export type TiktokErrorKind =
  | 'SESSION_BOOTSTRAP_FAILED'
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_HTTP_ERROR'
  | 'UPSTREAM_REJECTED'
  | 'UPSTREAM_THROTTLED'
  | 'UPSTREAM_BLOCKED'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_MALFORMED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'INTERNAL';

export interface TiktokErrorDetails {
  statusCode?: number;
  statusMessage?: string;
  logId?: string;
  url?: string;
  upstreamStatus?: number;
  body?: string;
  signed?: boolean;
  sessionAttached?: boolean;
  [key: string]: unknown;
}

export interface TiktokErrorPayload {
  kind: TiktokErrorKind;
  message: string;
  statusCode: number;
  details: TiktokErrorDetails;
  hint?: string;
}

export class TiktokError extends Error {
  readonly kind: TiktokErrorKind;
  readonly httpStatus: number;
  readonly details: TiktokErrorDetails;
  readonly hint?: string;

  constructor(
    kind: TiktokErrorKind,
    message: string,
    httpStatus: number,
    details: TiktokErrorDetails = {},
    hint?: string,
  ) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.details = details;
    this.hint = hint;
    Error.captureStackTrace?.(this, new.target);
  }

  toPayload(): TiktokErrorPayload {
    return {
      kind: this.kind,
      message: this.message,
      statusCode: this.httpStatus,
      details: this.details,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

export class SessionBootstrapError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('SESSION_BOOTSTRAP_FAILED', message, HttpStatus.BAD_GATEWAY, details, hint);
  }
}

export class UpstreamUnreachableError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('UPSTREAM_UNREACHABLE', message, HttpStatus.BAD_GATEWAY, details, hint);
  }
}

export class UpstreamTimeoutError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('UPSTREAM_TIMEOUT', message, HttpStatus.GATEWAY_TIMEOUT, details, hint);
  }
}

export class UpstreamHttpError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('UPSTREAM_HTTP_ERROR', message, HttpStatus.BAD_GATEWAY, details, hint);
  }
}

export class UpstreamRejectedError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('UPSTREAM_REJECTED', message, HttpStatus.BAD_GATEWAY, details, hint);
  }
}

export class UpstreamMalformedError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('UPSTREAM_MALFORMED', message, HttpStatus.BAD_GATEWAY, details, hint);
  }
}

export class UpstreamRateLimitedError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('UPSTREAM_RATE_LIMITED', message, HttpStatus.TOO_MANY_REQUESTS, details, hint);
  }
}

const THROTTLE_HINT =
  'TikTok did not return content. Three upstream shapes look identical from ' +
  'here and only one of them is a rate limit, so read the `transport` field on ' +
  '/internal/health before acting on this.\n' +
  '\n' +
  '  * If `transport.name` is not `tls`, this is almost certainly the TLS ' +
  'handshake: six API paths refuse a ClientHello that is not Chrome\'s, and ' +
  'they answer an empty body with `tt_orcas_res: 1` - byte for byte what a ' +
  'throttled edge sends. Restart with `TIKTOK_TRANSPORT=tls` and retry once ' +
  'before changing any pacing.\n' +
  '  * If `transport.name` is `tls`, the handshake was Chrome-shaped and this ' +
  'is the rate limit: TikTok applies per-IP overload protection and answers ' +
  'every request identically regardless of how it was signed, which is why ' +
  '`503 overload-protect triggered` and an empty 200 look the same. Raise ' +
  'TIKTOK_MIN_REQUEST_INTERVAL_MS, lower TIKTOK_MAX_CONCURRENT_REQUESTS, or ' +
  'wait for the window to clear.\n' +
  '\n' +
  'A throttled edge can also be a signed-out one: over-repeated requests on a ' +
  'single identity look the same as a busy IP. Restart the process for a fresh ' +
  'session if the window does not clear.';

export class UpstreamThrottledError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint: string = THROTTLE_HINT) {
    super('UPSTREAM_THROTTLED', message, HttpStatus.TOO_MANY_REQUESTS, details, hint);
  }
}

const BLOCK_HINT =
  'TikTok answered 200 OK with an empty body after every retry, and the ' +
  'response carried no throttle marker. That means the edge served a challenge ' +
  'or refused the client outright rather than pacing it. Check details.body for ' +
  'a WAF interstitial, and details.ticketGuardResult / details.orcas for the ' +
  "edge's verdict.";

export class UpstreamBlockedError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint: string = BLOCK_HINT) {
    super('UPSTREAM_BLOCKED', message, HttpStatus.BAD_GATEWAY, details, hint);
  }
}

export class NotFoundError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('NOT_FOUND', message, HttpStatus.NOT_FOUND, details, hint);
  }
}

export class BadRequestError extends TiktokError {
  constructor(message: string, details: TiktokErrorDetails = {}, hint?: string) {
    super('BAD_REQUEST', message, HttpStatus.BAD_REQUEST, details, hint);
  }
}

export const isTiktokError = (e: unknown): e is TiktokError => e instanceof TiktokError;
