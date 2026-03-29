import { AppError } from '@mem9/shared';
import { HttpException, HttpStatus } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import { AppExceptionFilter } from './app-exception.filter';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

describe('AppExceptionFilter', () => {
  afterEach(() => {
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

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });

  it('reports unexpected exceptions', () => {
    const filter = new AppExceptionFilter();
    const { host, response } = createHost();
    const error = new Error('boom');

    filter.catch(error, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });

  it('does not report client HttpExceptions', () => {
    const filter = new AppExceptionFilter();
    const { host, response } = createHost();
    const error = new HttpException('bad request', HttpStatus.BAD_REQUEST);

    filter.catch(error, host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
  });
});
