import { AppError, sanitizeErrorMessage } from '@mem9/shared';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { FastifyReply } from 'fastify';

import type { Mem9FastifyRequest } from './request-context';
import { resolveRequestId } from './request-id';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);
  public catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<Mem9FastifyRequest>();

    // Guards run before interceptors; retain denied requests in structured logs.
    this.logger.warn(JSON.stringify({
      event: 'request_rejected',
      requestId: resolveRequestId(request.id),
      method: request.method,
      route: request.routeOptions?.url ?? 'unmatched',
      statusCode: exception instanceof AppError ? exception.statusCode
        : exception instanceof HttpException ? exception.getStatus() : 500,
      apiKeyFingerprintHex: request.mem9Context?.apiKeyFingerprintHex,
    }));

    if (exception instanceof AppError) {
      if (exception.statusCode >= 500) {
        Sentry.captureException(exception);
      }

      response.status(exception.statusCode).send({
        code: exception.code,
        message: exception.message,
        requestId: request.id,
        details: exception.details,
      });
      return;
    }

    if (exception instanceof HttpException) {
      if (exception.getStatus() >= 500) {
        Sentry.captureException(exception);
      }

      response.status(exception.getStatus()).send({
        code: 'HTTP_EXCEPTION',
        message: sanitizeErrorMessage(exception),
        requestId: request.id,
        details: {
          cause: exception.getResponse(),
        },
      });
      return;
    }

    Sentry.captureException(exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      code: 'INTERNAL_SERVER_ERROR',
      message: sanitizeErrorMessage(exception),
      requestId: request.id,
    });
  }
}
