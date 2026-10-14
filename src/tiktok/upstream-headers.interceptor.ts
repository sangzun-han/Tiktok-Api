import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import type { TiktokResponse } from './tiktok.client';

@Injectable()
export class UpstreamHeadersInterceptor implements NestInterceptor<TiktokResponse, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<TiktokResponse>): Observable<unknown> {
    const res = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((upstream) => {
        res.setHeader('X-Tiktok-Logid', upstream.logId ?? '');
        res.setHeader('X-Tiktok-Upstream-Status', String(upstream.status));
        res.setHeader('X-Tiktok-Signed', String(upstream.signature.applied));
        res.setHeader('X-Tiktok-Sign-Ms', String(upstream.signature.ms));
        res.setHeader('X-Tiktok-Elapsed-Ms', String(upstream.elapsedMs));
        res.setHeader('X-Tiktok-Attempts', String(upstream.attempts));
        if (upstream.ticketGuardResult !== undefined) {
          res.setHeader('X-Tiktok-Ticket-Guard', String(upstream.ticketGuardResult));
        }
        return upstream.data;
      }),
    );
  }
}
