import type { ExecutionContext } from '@nestjs/common';

import { RateLimitGuard } from './rate-limit.guard';

describe('rate limit guard', () => {
  it('reserves the full daily workload for source-backed analysis', async () => {
    const repository = {
      ensureApiKeySubject: jest.fn(async () => ({ planCode: 'default' })),
      getRateLimitPolicy: jest.fn(async () => ({
        rpmLimit: 120,
        dailyLimit: 10000,
      })),
    };
    const rateLimitWindowService = {
      consume: jest.fn(async () => undefined),
    };
    const guard = new RateLimitGuard(
      repository as never,
      rateLimitWindowService as never,
    );
    const request = {
      method: 'POST',
      url: '/v1/analysis-jobs/from-source',
      body: {
        expectedTotalBatches: 112,
      },
      mem9Context: {
        apiKeyFingerprint: Buffer.alloc(32),
        apiKeyFingerprintHex: '00',
      },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(rateLimitWindowService.consume).toHaveBeenCalledWith(
      '00',
      expect.objectContaining({ rpmLimit: 120 }),
      {
        minute: 2,
        day: 338,
      },
    );
  });

  it('keeps browser-uploaded batch requests at cost three', async () => {
    const repository = {
      ensureApiKeySubject: jest.fn(async () => ({ planCode: 'default' })),
      getRateLimitPolicy: jest.fn(async () => ({
        rpmLimit: 120,
        dailyLimit: 10000,
      })),
    };
    const rateLimitWindowService = {
      consume: jest.fn(async () => undefined),
    };
    const guard = new RateLimitGuard(
      repository as never,
      rateLimitWindowService as never,
    );
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'PUT',
          url: '/v1/analysis-jobs/aj_1/batches/1',
          mem9Context: {
            apiKeyFingerprint: Buffer.alloc(32),
            apiKeyFingerprintHex: '00',
          },
        }),
      }),
    } as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(rateLimitWindowService.consume).toHaveBeenCalledWith(
      '00',
      expect.anything(),
      3,
    );
  });
});
