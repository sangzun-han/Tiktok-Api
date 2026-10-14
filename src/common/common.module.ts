import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from '../config/configuration';
import { TlsImpersonateTransport } from './http/tls-impersonate.transport';
import { HttpClient } from './http/http-client';
import { RateLimiter } from './http/rate-limiter';

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    HttpClient,
    TlsImpersonateTransport,
    {
      provide: RateLimiter,
      useFactory: (config: ReturnType<typeof loadConfig>) =>
        new RateLimiter({
          minIntervalMs: config.tiktok.minRequestIntervalMs,
          maxConcurrent: config.tiktok.maxConcurrentRequests,
        }),
      inject: [CONFIG],
    },
  ],
  exports: [CONFIG, HttpClient, RateLimiter],
})
export class CommonModule {}
