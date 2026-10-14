import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { UpstreamUnreachableError } from '../errors/tiktok-errors';

export interface ImpersonatedRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface ImpersonatedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type ImpersonationBackend = 'node-tls-client' | 'curl_cffi' | 'none';

export interface BackendStatus {
  name: ImpersonationBackend;
  available: boolean;
  reason?: string;
}

interface TlsSession {
  get(url: string, options?: Record<string, unknown>): Promise<TlsResponse>;
  post(url: string, options?: Record<string, unknown>): Promise<TlsResponse>;
  close(): Promise<void>;
}
interface TlsResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Uint8Array;
}
interface TlsModule {
  initTLS(): Promise<void>;
  destroyTLS(): Promise<void>;
  Session: new (options: Record<string, unknown>) => TlsSession;
}

interface Pending {
  resolve: (value: ImpersonatedResponse) => void;
  reject: (reason: Error) => void;
}

@Injectable()
export class TlsImpersonateTransport implements OnModuleDestroy {
  private readonly logger = new Logger(TlsImpersonateTransport.name);

  private readonly backends: BackendStatus[] = [];
  private chosen: ImpersonationBackend = 'none';

  private tls: TlsModule | null = null;
  private session: TlsSession | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private starting: Promise<void> | null = null;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.tiktok.transport === 'tls';
  }

  get backend(): ImpersonationBackend {
    return this.chosen;
  }

  get status(): BackendStatus[] {
    return this.backends.map((entry) => ({ ...entry }));
  }

  async tryRequest(request: ImpersonatedRequest): Promise<ImpersonatedResponse | null> {
    if (!this.enabled) return null;
    try {
      await this.ensureStarted();
    } catch (error) {
      this.logger.warn(
        `no Chrome-shaped transport is available: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    if (this.chosen === 'none') return null;
    return this.chosen === 'curl_cffi'
      ? this.requestViaBridge(request)
      : this.requestViaAddon(request);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.child) {
      try {
        this.child.stdin.write('{"method":"__quit__"}\n');
      } catch {  }
      this.child.kill();
      this.child = null;
    }
    this.failPending('transport is shutting down');
    try {
      await this.session?.close();
    } catch {  }
    this.session = null;
    try {
      await this.tls?.destroyTLS();
    } catch {  }
    this.tls = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.chosen !== 'none') return;
    if (this.starting) return this.starting;
    this.starting = this.select().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async select(): Promise<void> {
    if (await this.tryAddon()) {
      this.chosen = 'node-tls-client';
      this.logger.log('Transport: tls via node-tls-client (Chrome ClientHello)');
      return;
    }
    if (await this.tryBridge()) {
      this.chosen = 'curl_cffi';
      this.logger.log('Transport: tls via curl_cffi (Chrome ClientHello, out of process)');
      return;
    }
    this.logger.warn(
      'No Chrome-shaped transport could be started, so undici is carrying requests. ' +
        'The six API paths that check the handshake will answer an empty body. ' +
        'See /internal/health for why each one was rejected.',
    );
  }

  private async tryAddon(): Promise<boolean> {
    const name: ImpersonationBackend = 'node-tls-client';
    let module: TlsModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      module = require('node-tls-client') as TlsModule;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const hardened = /Team ID|different Team|code signature/i.test(detail);
      this.reject(name, hardened
        ? 'this Node is signed with the hardened runtime and a Team ID, so macOS ' +
          'refuses the addon. Run with a normal Node build, or install curl_cffi.'
        : `could not load: ${detail.split('\n')[0].slice(0, 160)}`);
      return false;
    }

    try {
      await module.initTLS();
      this.tls = module;
      this.session = new module.Session({
        clientIdentifier: this.config.tiktok.tlsClientIdentifier,
        timeout: Math.max(1, Math.round(this.config.tiktok.timeoutMs / 1000)),
      });
    } catch (error) {
      this.reject(name, `initTLS failed: ${
        error instanceof Error ? error.message.slice(0, 140) : String(error)}`);
      return false;
    }

    const ok = await this.probe(name, (url) => this.session!.get(url, { timeout: 15 }));
    if (ok) {
      this.accept(name);
      return true;
    }
    await this.session?.close().catch(() => undefined);
    this.session = null;
    this.tls = null;
    return false;
  }

  private async tryBridge(): Promise<boolean> {
    const name: ImpersonationBackend = 'curl_cffi';
    let script: string;
    try {
      script = TlsImpersonateTransport.resolveBridgeScript();
    } catch (error) {
      this.reject(name, error instanceof Error ? error.message.slice(0, 160) : String(error));
      return false;
    }

    const python = this.config.tiktok.pythonPath || 'python3';
    const child = spawn(python, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    }) as ChildProcessWithoutNullStreams;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeBridge(chunk));
    child.stderr.setEncoding('utf8');

    let stderr = '';
    child.stderr.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) stderr = (stderr + ' ' + text).slice(-400);
    });
    child.on('exit', (code, signal) => {
      if (this.chosen === 'curl_cffi') {
        this.logger.warn(`curl_cffi bridge exited (code=${code} signal=${signal})`);
      }
      this.child = null;
      this.failPending('curl_cffi bridge exited');
    });
    child.on('error', (error) => {
      this.reject(name, `could not start ${python}: ${error.message}`);
      this.child = null;
    });
    this.child = child;

    const ok = await this.probe(name, (url) => this.bridgeCall({ method: 'GET', url, timeoutMs: 15_000 }));
    if (ok) {
      this.accept(name);
      return true;
    }
    try {
      child.kill();
    } catch {  }
    this.child = null;
    this.failPending('probe failed');
    const settled = this.backends.find((b) => b.name === name);
    if (settled && !settled.reason && stderr.trim()) {
      settled.reason = stderr.trim().slice(0, 200);
    }
    return false;
  }

  private async probe(
    name: ImpersonationBackend,
    send: (url: string) => Promise<{ status: number }>,
  ): Promise<boolean> {
    const url = `${this.config.tiktok.origin}/`;
    try {
      const answer = await send(url);
      if (answer.status > 0) return true;
      this.reject(name, 'the probe request came back with no HTTP status');
      return false;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!this.backends.some((b) => b.name === name && b.reason)) {
        this.reject(name, `probe failed: ${detail.slice(0, 160)}`);
      }
      return false;
    }
  }

  private accept(name: ImpersonationBackend): void {
    const existing = this.backends.find((entry) => entry.name === name);
    if (existing) {
      existing.available = true;
      delete existing.reason;
    } else {
      this.backends.push({ name, available: true });
    }
  }

  private reject(name: ImpersonationBackend, reason: string): void {
    const existing = this.backends.find((entry) => entry.name === name);
    if (existing) {
      existing.available = false;
      existing.reason = reason;
    } else {
      this.backends.push({ name, available: false, reason });
    }
  }

  private async requestViaAddon(request: ImpersonatedRequest): Promise<ImpersonatedResponse> {
    const session = this.session;
    if (!session) throw new UpstreamUnreachableError('TLS session is not available');

    const options: Record<string, unknown> = {
      headers: request.headers ?? {},
      timeout: Math.max(1, Math.round((request.timeoutMs ?? 30_000) / 1000)),
    };
    if (request.body !== undefined) options.body = request.body;

    try {
      const response =
        request.method.toUpperCase() === 'POST'
          ? await session.post(request.url, options)
          : await session.get(request.url, options);
      return {
        status: response.status,
        headers: TlsImpersonateTransport.flatten(response.headers),
        body: Buffer.isBuffer(response.body)
          ? response.body
          : Buffer.from(response.body as Uint8Array | string),
      };
    } catch (error) {
      throw new UpstreamUnreachableError(
        `TLS transport failed for ${request.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private requestViaBridge(request: ImpersonatedRequest): Promise<ImpersonatedResponse> {
    return this.bridgeCall(request);
  }

  private bridgeCall(request: ImpersonatedRequest): Promise<ImpersonatedResponse> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new UpstreamUnreachableError('curl_cffi bridge is not running'));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      id,
      method: request.method,
      url: request.url,
      headers: request.headers ?? {},
      body: request.body === undefined ? null : Buffer.from(request.body).toString('base64'),
      timeout: Math.max(1, Math.round((request.timeoutMs ?? 30_000) / 1000)),
      redirects: true,
    });

    return new Promise<ImpersonatedResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        child.stdin.write(payload + '\n');
      } catch (error) {
        this.pending.delete(id);
        reject(new UpstreamUnreachableError(
          `could not write to the curl_cffi bridge: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ));
      }
    });
  }

  private consumeBridge(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.settleBridge(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private settleBridge(line: string): void {
    let parsed: {
      id?: number; error?: string; status?: number;
      headers?: Record<string, string>; body?: string;
    };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      this.logger.warn(`bridge wrote a non-JSON line: ${line.slice(0, 160)}`);
      return;
    }
    if (typeof parsed.id !== 'number') return;
    const waiter = this.pending.get(parsed.id);
    if (!waiter) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      waiter.reject(new UpstreamUnreachableError(`curl_cffi bridge: ${parsed.error}`));
      return;
    }
    waiter.resolve({
      status: parsed.status ?? 0,
      headers: parsed.headers ?? {},
      body: Buffer.from(parsed.body ?? '', 'base64'),
    });
  }

  private failPending(reason: string): void {
    for (const [, waiter] of this.pending) {
      waiter.reject(new UpstreamUnreachableError(reason));
    }
    this.pending.clear();
  }

  private static resolveBridgeScript(): string {
    const candidates = [
      join(__dirname, '..', '..', '..', 'bridge', 'curl_cffi_bridge.py'),
      join(process.cwd(), 'bridge', 'curl_cffi_bridge.py'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    throw new UpstreamUnreachableError(
      `curl_cffi bridge script not found; looked in ${candidates.join(', ')}`,
    );
  }

  private static flatten(headers: Record<string, string | string[]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return out;
  }
}
