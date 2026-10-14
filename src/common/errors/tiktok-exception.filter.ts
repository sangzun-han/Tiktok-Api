import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { isTiktokError, TiktokError } from './tiktok-errors';

interface ErrorEnvelope {
  error: {
    kind: string;
    message: string;
    statusCode: number;
    requestId?: string;
    path?: string;
    details?: Record<string, unknown>;
    hint?: string;
  };
}

@Catch()
export class TiktokExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('TiktokError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? request.headers['x-request-id'];

    const envelope = this.toEnvelope(exception, request, requestId);
    const status = envelope.error.statusCode;

    if (status >= 500) {
      this.logger.error(
        `[${requestId ?? '-'}] ${request.method} ${request.originalUrl} -> ${status} ${envelope.error.kind}: ${envelope.error.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (isTiktokError(exception)) {
      this.logger.warn(
        `[${requestId ?? '-'}] ${request.method} ${request.originalUrl} -> ${status} ${envelope.error.kind}: ${envelope.error.message}` +
          (exception.details.logId ? ` (logId=${exception.details.logId})` : ''),
      );
    } else {
      this.logger.warn(
        `[${requestId ?? '-'}] ${request.method} ${request.originalUrl} -> ${status}: ${envelope.error.message}`,
      );
    }

    if (response.headersSent) return;
    response.status(status).json(envelope);
  }

  private toEnvelope(
    exception: unknown,
    request: Request,
    requestId: string | string[] | undefined,
  ): ErrorEnvelope {
    const id = Array.isArray(requestId) ? requestId[0] : requestId;

    if (isTiktokError(exception)) {
      const payload = (exception as TiktokError).toPayload();
      return {
        error: {
          kind: payload.kind,
          message: payload.message,
          statusCode: payload.statusCode,
          requestId: id,
          path: request.originalUrl,
          details: payload.details,
          hint: payload.hint,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      return {
        error: {
          kind: status === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : 'BAD_REQUEST',
          message: Array.isArray(message) ? message.join('; ') : message,
          statusCode: status,
          requestId: id,
          path: request.originalUrl,
          details: typeof body === 'object' && body !== null ? { validation: body } : {},
        },
      };
    }

    return {
      error: {
        kind: 'INTERNAL',
        message: 'An unexpected internal error occurred.',
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        requestId: id,
        path: request.originalUrl,
      },
    };
  }
}
