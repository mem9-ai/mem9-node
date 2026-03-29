import { AppError, sanitizeErrorMessage } from '@mem9/shared';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { FastifyReply } from 'fastify';

import type { Mem9FastifyRequest } from './request-context';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<Mem9FastifyRequest>();

    if (exception instanceof AppError) {
      if (exception.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
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
      if (exception.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR) {
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
