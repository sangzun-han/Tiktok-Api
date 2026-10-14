import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { CONFIG, type AppConfig } from '../config/configuration';
import { HttpClient } from '../common/http/http-client';
import { SessionBootstrapError } from '../common/errors/tiktok-errors';
import { AppContext, parseAppContext } from './app-context';

export interface SessionSnapshot {
  cookies: Record<string, string>;
  cookieHeader: string;
  webId: string;
  aid: number;
  region: string;
  odinId?: string;
  nonce?: string;
  csrfToken?: string;
  botType?: string;
  abTestVersions?: string;
  msToken?: string;
  ttwid?: string;
  identityFromPage: boolean;
  createdAt: number;
  expiresAt: number;
  requestCount: number;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private current?: SessionSnapshot;
  private inflight?: Promise<SessionSnapshot>;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly http: HttpClient,
  ) {}

  async get(): Promise<SessionSnapshot> {
    const session = this.current;
    if (session && this.isUsable(session)) {
      session.requestCount += 1;
      return session;
    }
    return this.bootstrap();
  }

  invalidate(reason: string): void {
    if (this.current) {
      this.logger.debug(`Dropping session: ${reason}`);
    }
    this.current = undefined;
  }

  describe(): Omit<SessionSnapshot, 'cookies' | 'cookieHeader'> & { cookieNames: string[] } {
    const s = this.current;
    if (!s) {
      throw new SessionBootstrapError(
        'No session has been bootstrapped yet.',
        {},
        'Call any TikTok endpoint first, or GET /internal/session to force a bootstrap.',
      );
    }
    const { cookies, cookieHeader: _cookieHeader, ...rest } = s;
    return { ...rest, cookieNames: Object.keys(cookies) };
  }

  private isUsable(session: SessionSnapshot): boolean {
    if (Date.now() >= session.expiresAt) return false;
    if (session.requestCount >= this.config.session.maxRequestsPerSession) return false;

    return Boolean(session.msToken);
  }

  private async bootstrap(): Promise<SessionSnapshot> {
    if (this.inflight) return this.inflight;
    const task = this.performBootstrap().finally(() => {
      this.inflight = undefined;
    });
    this.inflight = task;
    return task;
  }

  private async performBootstrap(): Promise<SessionSnapshot> {
    const cookies: Record<string, string> = {};
    const now = Date.now();

    await this.registerDevice(cookies);

    const { appContext, ttwid } = await this.loadIdentity(cookies);

    if (!ttwid) {
      throw new SessionBootstrapError(
        'TikTok did not issue a ttwid cookie during session bootstrap.',
        { cookies: Object.keys(cookies) },
        'The edge may be rejecting this egress IP outright. Try a different ' +
          'network or set TIKTOK_PROXY_URL to a residential proxy.',
      );
    }

    // Must be 1988. The page's app-context reports 1180, which the API rejects.
    const aid = this.config.tiktok.appId;
    const region = appContext?.region ?? this.config.tiktok.region;
    const webId = appContext?.wid ?? SessionService.generateWebId();

    if (!appContext?.wid) {
      this.logger.warn(
        'The page did not expose a `wid`. Falling back to a locally generated ' +
          'device id, which the edge is unlikely to accept.',
      );
    }

    const bootstrapUrl = this.buildUrl('/api/recommend/item_list/', {
      aid: String(aid),
      count: '10',
      app_name: this.config.tiktok.appName,
      device_platform: this.config.tiktok.devicePlatform,
      device_id: webId,
      region,
      priority_region: region,
    });

    await this.collect(bootstrapUrl, cookies, 'msToken bootstrap', 'application/json, text/plain, */*');

    if (!cookies['msToken']) {
      this.logger.warn(
        'TikTok did not issue an msToken during bootstrap. Content endpoints ' +
          'will most likely answer with an empty 200 until one is obtained.',
      );
    }

    const session: SessionSnapshot = {
      cookies,
      cookieHeader: SessionService.serialiseCookies(cookies),
      webId,
      aid,
      region,
      odinId: appContext?.odinId,
      nonce: appContext?.nonce,
      csrfToken: appContext?.csrfToken ?? cookies['tt_csrf_token'],
      botType: appContext?.botType,
      abTestVersions: appContext?.abTestVersions,
      msToken: cookies['msToken'],
      ttwid: cookies['ttwid'],
      identityFromPage: Boolean(appContext?.wid),
      createdAt: now,
      expiresAt: now + this.config.session.ttlMs,
      requestCount: 0,
    };

    this.current = session;

    this.logger.log(
      `Session bootstrapped (wid=${webId}, aid=${aid}, region=${region}, ` +
        `cookies=${Object.keys(cookies).join(',')}, ` +
        `msToken=${session.msToken ? `${session.msToken.length} chars` : 'absent'}, ` +
        `identityFromPage=${session.identityFromPage})`,
    );
    return session;
  }

  private async registerDevice(cookies: Record<string, string>): Promise<void> {
    const url = `${this.config.tiktok.origin}/ttwid/union/register/`;
    try {
      const response = await this.http.send(url, {
        method: 'POST',
        body: JSON.stringify({
          region: this.config.tiktok.region,
          aid: this.config.tiktok.appId,
          needFid: false,
          service: 'www.tiktok.com',
          migrate_info: { ticket: '', source: 'node' },
          cbUrlProtocol: 'https',
          union: true,
        }),
        headers: {
          'User-Agent': this.config.tiktok.userAgent,
          'Content-Type': 'application/json',
          Accept: '*/*',
        },
      });

      for (const [name, value] of SessionService.readSetCookies(response.headers)) {
        if (value) cookies[name] = value;
      }

      const body = response.body.toString('utf8');
      this.logger.debug(
        `device registration: HTTP ${response.status}, ttwid=${cookies['ttwid'] ? 'set' : 'absent'}, ${body.slice(0, 80)}`,
      );
    } catch (error) {
      this.logger.warn(
        `Device registration failed; falling back to the cookie a page load sets: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async loadIdentity(
    cookies: Record<string, string>,
  ): Promise<{ appContext?: AppContext; ttwid?: string }> {
    // `/` often serves a WAF challenge without cookies. `/explore` reliably issues ttwid.
    const paths = ['/explore', '/', '/foryou'];
    let fallbackTtwid: string | undefined;
    const errors: string[] = [];

    for (const path of paths) {
      try {
        const html = await this.collect(
          `${this.config.tiktok.origin}${path}`,
          cookies,
          `identity bootstrap ${path}`,
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        );

        const ttwid = cookies['ttwid'];
        if (ttwid && !fallbackTtwid) fallbackTtwid = ttwid;

        const appContext = html ? parseAppContext(html) : undefined;
        if (appContext?.wid) {
          return { appContext, ttwid };
        }
        errors.push(`${path}: no app-context`);
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.logger.warn(`Could not obtain an app context (${errors.join('; ')})`);
    return { appContext: undefined, ttwid: fallbackTtwid };
  }

  private async collect(
    url: string,
    jar: Record<string, string>,
    label: string,
    accept: string,
  ): Promise<string | undefined> {
    let response;
    try {
      response = await this.http.send(url, {
        headers: {
          'User-Agent': this.config.tiktok.userAgent,
          Accept: accept,
          'Accept-Language': `${this.config.tiktok.language}-${this.config.tiktok.region},${this.config.tiktok.language};q=0.9`,
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: `${this.config.tiktok.origin}/`,
          ...(Object.keys(jar).length ? { Cookie: SessionService.serialiseCookies(jar) } : {}),
        },
      });
    } catch (error) {
      throw new SessionBootstrapError(
        `Session bootstrap request failed during ${label}.`,
        { url, cause: error instanceof Error ? error.message : String(error) },
        'Check outbound connectivity and any configured proxy.',
      );
    }

    if (response.status >= 400) {
      throw new SessionBootstrapError(
        `Session bootstrap hit HTTP ${response.status} during ${label}.`,
        { url, upstreamStatus: response.status, body: response.body.toString('utf8').slice(0, 300) },
      );
    }

    const setCookies = SessionService.readSetCookies(response.headers);
    for (const [name, value] of setCookies) {
      if (value === '') continue;
      jar[name] = value;
    }
    this.logger.debug(`${label}: HTTP ${response.status}, +${setCookies.length} cookie(s)`);

    return response.body.toString('utf8');
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    const params = new URLSearchParams(query);
    return `${this.config.tiktok.origin}${path}?${params.toString()}`;
  }

  static readSetCookies(
    headers: Record<string, string | string[] | undefined>,
  ): Array<[string, string]> {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: Array<[string, string]> = [];
    for (const entry of list) {
      const first = entry.split(';', 1)[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      out.push([first.slice(0, eq).trim(), first.slice(eq + 1).trim()]);
    }
    return out;
  }

  static serialiseCookies(cookies: Record<string, string>): string {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  static generateWebId(): string {
    let id = '7';
    for (let i = 0; i < 18; i++) id += String(randomInt(0, 10));
    return id;
  }
}
