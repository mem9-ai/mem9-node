import { AppError } from '@mem9/shared';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import { AppExceptionFilter } from './app-exception.filter';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

describe('AppExceptionFilter', () => {
  it.each([
    new Error('Prisma: secret database password at db.internal'),
    new AppError('upstream secret response', {
      statusCode: 503, code: 'UPSTREAM_UNAVAILABLE', details: { body: 'private tenant content' },
    }),
    new HttpException({ message: 'private database failure', credentials: 'secret' }, 500),
  ])('hides internal server messages and details while retaining the request id', (error) => {
    const { host, response } = createHost();
    new AppExceptionFilter().catch(error, host);
    expect(response.send).toHaveBeenCalledWith({
      code: error instanceof AppError ? error.code : error instanceof HttpException ? 'HTTP_EXCEPTION' : 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error', requestId: 'req_123',
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(error, { tags: { requestId: 'req_123' } });
  });

  it('preserves actionable client validation errors', () => {
    const { host, response } = createHost();
    const cause = { message: ['lang must be shorter than or equal to 32 characters'], statusCode: 400 };
    new AppExceptionFilter().catch(new HttpException(cause, 400), host);
    expect(response.send).toHaveBeenCalledWith(expect.objectContaining({ details: { cause } }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function createHost() {
    const response = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    const request = {
      id: 'req_123',
    };
    const http = {
      getResponse: jest.fn().mockReturnValue(response),
      getRequest: jest.fn().mockReturnValue(request),
    };

    return {
      host: {
        switchToHttp: jest.fn().mockReturnValue(http),
      } as never,
      request,
      response,
    };
  }

  it('does not report client-facing AppError responses', () => {
    const filter = new AppExceptionFilter();
    const { host, response } = createHost();
    const error = new AppError('Batch index is out of range', {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'BATCH_INDEX_OUT_OF_RANGE',
    });

    filter.catch(error, host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('reports server AppError responses', () => {
    const filter = new AppExceptionFilter();
    const { host, response } = createHost();
    const error = new AppError('APP_PEPPER is not configured', {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'APP_PEPPER_NOT_CONFIGURED',
    });

    filter.catch(error, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(error, { tags: { requestId: 'req_123' } });
    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });

  it('reports unexpected exceptions', () => {
    const filter = new AppExceptionFilter();
    const { host, response } = createHost();
    const error = new Error('boom');

    filter.catch(error, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(error, { tags: { requestId: 'req_123' } });
    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });

  it('does not report client HttpExceptions', () => {
    const filter = new AppExceptionFilter();
    const { host, response } = createHost();
    const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = new HttpException('bad request', HttpStatus.BAD_REQUEST);

    filter.catch(error, host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('request_rejected'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('req_123'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('400'));
  });
});
