import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import * as zlib from 'zlib';
import { Agent, Dispatcher, ProxyAgent, request } from 'undici';
import { TlsImpersonateTransport } from './tls-impersonate.transport';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { UpstreamMalformedError } from '../errors/tiktok-errors';

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  dispatcher?: Dispatcher;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  elapsedMs: number;
}

const CHROME_TLS = {
  ciphers: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-SHA',
    'ECDHE-RSA-AES256-SHA',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
  ].join(':'),
  sigalgs: [
    'ecdsa_secp256r1_sha256',
    'rsa_pss_rsae_sha256',
    'rsa_pkcs1_sha256',
    'ecdsa_secp384r1_sha384',
    'rsa_pss_rsae_sha384',
    'rsa_pkcs1_sha384',
    'rsa_pss_rsae_sha512',
    'rsa_pkcs1_sha512',
  ].join(':'),
  ecdhCurve: 'X25519:P-256:P-384',
  ALPNProtocols: ['h2', 'http/1.1'],
  minVersion: 'TLSv1.2' as const,
  maxVersion: 'TLSv1.3' as const,
};

@Injectable()
export class HttpClient implements OnModuleDestroy {
  private readonly logger = new Logger(HttpClient.name);
  private transportWarned = false;
  private readonly dispatcher: Dispatcher;

  private readonly impersonator: TlsImpersonateTransport;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() impersonator?: TlsImpersonateTransport,
  ) {
    this.impersonator = impersonator ?? new TlsImpersonateTransport(config);
    this.dispatcher = HttpClient.createDispatcher(config.tiktok.proxyUrl, config.tiktok.http2);
    this.logger.log(
      config.tiktok.transport === 'tls'
        ? 'Transport: tls (Chrome ClientHello via node-tls-client).'
        : 'Transport: undici (Node/OpenSSL ClientHello). Six API paths will refuse ' +
            'this handshake; set TIKTOK_TRANSPORT=tls to reach them.',
    );
    if (config.tiktok.proxyUrl) {
      const redacted = config.tiktok.proxyUrl.replace(/\/\/[^@]*@/, '//***@');
      this.logger.log(`Upstream proxy enabled: ${redacted}`);
    }
  }

  private static createDispatcher(proxyUrl: string | undefined, http2: boolean): Dispatcher {
    if (proxyUrl) {
      return new ProxyAgent({
        uri: proxyUrl,
        connections: 8,
        pipelining: 1,
        allowH2: http2,
        connect: CHROME_TLS,
      });
    }
    return new Agent({
      connections: 16,
      pipelining: 1,
      allowH2: http2,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connect: CHROME_TLS,
    });
  }

  get impersonatorStatus(): {
    inUse: 'tls' | 'undici';
    backend: string;
    backends: Array<{ name: string; available: boolean; reason?: string }>;
  } {
    const backend = this.impersonator.backend;
    return {
      inUse: backend === 'none' ? 'undici' : 'tls',
      backend,
      backends: this.impersonator.status,
    };
  }

  async send(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const started = Date.now();
    const timeout = options.timeoutMs ?? this.config.tiktok.timeoutMs;

    if (this.impersonator.enabled) {
      const answer = await this.impersonator.tryRequest({
        method: options.method ?? 'GET',
        url,
        headers: options.headers as Record<string, string> | undefined,
        body: typeof options.body === 'string' ? options.body : options.body?.toString(),
        timeoutMs: timeout,
      });
      if (answer) {
        return {
          status: answer.status,
          headers: answer.headers,
          body: answer.body,
          elapsedMs: Date.now() - started,
        };
      }

      if (!this.transportWarned) {
        this.transportWarned = true;
        this.logger.warn(
          'No Chrome-shaped transport is available, so undici is carrying requests. ' +
            'The six paths that check the handshake will answer an empty body. ' +
            'See /internal/health for the reason each backend was rejected.',
        );
      }
    }

    const response = await request(url, {
      method: (options.method ?? 'GET') as Dispatcher.HttpMethod,
      headers: options.headers,
      body: options.body,
      dispatcher: options.dispatcher ?? this.dispatcher,
      headersTimeout: timeout,
      bodyTimeout: timeout,
      maxRedirections: 3,
    });

    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const headers = response.headers as Record<string, string | string[] | undefined>;
    const raw = Buffer.concat(chunks);

    return {
      status: response.statusCode,
      headers,
      body: await HttpClient.decompress(raw, headers),
      elapsedMs: Date.now() - started,
    };
  }

  private static async decompress(
    body: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Buffer> {
    if (body.length === 0) return body;

    const raw = headers['content-encoding'];
    const encoding = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
    if (!encoding || encoding === 'identity') return body;

    const decode = (fn: (b: Buffer, cb: (e: Error | null, r: Buffer) => void) => void) =>
      new Promise<Buffer>((resolve, reject) => {
        fn(body, (error, result) => (error ? reject(error) : resolve(result)));
      });

    try {
      switch (encoding) {
        case 'gzip':
        case 'x-gzip':
          return await decode(zlib.gunzip.bind(zlib));
        case 'deflate':
          return await decode(zlib.inflate.bind(zlib));
        case 'br':
          return await decode(zlib.brotliDecompress.bind(zlib));
        case 'zstd':

          if (typeof (zlib as { zstdDecompress?: unknown }).zstdDecompress === 'function') {
            return await decode(
              (zlib as unknown as {
                zstdDecompress: (b: Buffer, cb: (e: Error | null, r: Buffer) => void) => void;
              }).zstdDecompress.bind(zlib),
            );
          }
          throw new Error('zstd responses are not supported by this Node build');
        default:

          return body;
      }
    } catch (error) {
      throw new UpstreamMalformedError(
        `Could not decode a "${encoding}" response body.`,
        { contentEncoding: encoding, bytes: body.length, cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
