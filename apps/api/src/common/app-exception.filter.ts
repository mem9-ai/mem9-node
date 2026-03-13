import { AppError, sanitizeErrorMessage } from '@mem9/shared';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';


import type { Mem9FastifyRequest } from './request-context';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<Mem9FastifyRequest>();

    if (exception instanceof AppError) {
      response.status(exception.statusCode).send({
        code: exception.code,
        message: exception.message,
        requestId: request.id,
        details: exception.details,
      });
      return;
    }

    if (exception instanceof HttpException) {
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

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      code: 'INTERNAL_SERVER_ERROR',
      message: sanitizeErrorMessage(exception),
      requestId: request.id,
    });
  }
}
