import { AppError, type AnalysisRepository } from '@mem9/shared';
import { BadRequestException, Logger } from '@nestjs/common';
import { EMPTY, lastValueFrom, of, throwError } from 'rxjs';

import { RequestAuditInterceptor } from './request-audit.interceptor';

function setup() {
  const repository = { recordAudit: jest.fn<ReturnType<AnalysisRepository['recordAudit']>, Parameters<AnalysisRepository['recordAudit']>>().mockResolvedValue(undefined) };
  const request = {
    id: 'request-1',
    url: '/v1/jobs/123?secret=hidden',
    routeOptions: { url: '/v1/jobs/:jobId' },
    params: { jobId: 'job-1', batchIndex: '0' },
    body: { memoryCount: 5 },
    mem9Context: { apiKeyFingerprint: Buffer.alloc(32, 1) },
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode: 202 }),
    }),
  };
  return {
    repository,
    request,
    context,
    interceptor: new RequestAuditInterceptor(repository as never),
  };
}

describe('request audit', () => {
  afterEach(() => jest.restoreAllMocks());
  it('records one completed request without changing the response or zero batch index', async () => {
    const { interceptor, context, repository } = setup();
    expect(
      await lastValueFrom(
        interceptor.intercept(context as never, {
          handle: () => of({ ok: true }),
        }),
      ),
    ).toEqual({ ok: true });
    expect(repository.recordAudit).toHaveBeenCalledTimes(1);
    expect(repository.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 202,
        batchIndex: 0,
        memoryCount: 5,
      }),
    );
  });
  it.each([
    [new AppError('Forbidden', { statusCode: 403, code: 'FORBIDDEN' }), 403],
    [new BadRequestException(), 400],
    [new Error('Unexpected'), 500],
  ])(
    'records failed requests with actual status %#',
    async (error, statusCode) => {
      const { interceptor, context, repository } = setup();
      await expect(
        lastValueFrom(
          interceptor.intercept(context as never, {
            handle: () => throwError(() => error),
          }),
        ),
      ).rejects.toBe(error);
      expect(repository.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode }),
      );
    },
  );
  it('bounds attacker-controlled metadata and records empty responses', async () => {
    const { interceptor, context, request, repository } = setup();
    request.id = 'x'.repeat(200);
    request.params.jobId = 'x'.repeat(200);
    request.params.batchIndex = '9999999999999999999';
    request.body.memoryCount = Infinity;
    await lastValueFrom(
      interceptor.intercept(context as never, { handle: () => EMPTY }),
      { defaultValue: null },
    );
    const data = repository.recordAudit.mock.calls[0]![0];
    expect(data.requestId).toHaveLength(36);
    expect(data.jobId).toHaveLength(64);
    expect(data.batchIndex).toBeNull();
    expect(data.memoryCount).toBeNull();
  });
  it('reports persistence failures without rejecting successful requests or logging database secrets', async () => {
    const { interceptor, context, repository } = setup();
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.recordAudit.mockRejectedValue(new Error('mysql://password'));
    expect(
      await lastValueFrom(
        interceptor.intercept(context as never, { handle: () => of('ok') }),
      ),
    ).toBe('ok');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('request_audit_write_failed'),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('password');
  });
});
