import type { ExecutionContext } from '@nestjs/common';

import { RateLimitGuard } from './rate-limit.guard';

function createRepository() {
  return {
    ensureApiKeySubject: jest.fn(),
    findApiKeySubject: jest.fn(),
    recordVerifiedApiKeySubject: jest.fn(),
    getRateLimitPolicy: jest.fn(async () => ({
      rpmLimit: 120,
      dailyLimit: 10000,
    })),
  };
}

function activeSubject(status: 'ACTIVE' | 'DISABLED' | 'PENDING' = 'ACTIVE') {
  return { id: 'aks_1', status, planCode: 'default' };
}

function buildContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

describe('rate limit guard', () => {
  it('reserves the full daily workload for source-backed analysis', async () => {
    const repository = createRepository();
    const rateLimitWindowService = {
      consume: jest.fn(async () => undefined),
    };
    const guard = new RateLimitGuard(
      repository as never,
      rateLimitWindowService as never,
    );
    const context = buildContext({
      method: 'POST',
      url: '/v1/analysis-jobs/from-source',
      body: {
        expectedTotalBatches: 112,
      },
      mem9Context: {
        apiKeyFingerprint: Buffer.alloc(32),
        apiKeyFingerprintHex: '00',
      },
      mem9ApiKeySubject: activeSubject(),
    });

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
    const repository = createRepository();
    const rateLimitWindowService = {
      consume: jest.fn(async () => undefined),
    };
    const guard = new RateLimitGuard(
      repository as never,
      rateLimitWindowService as never,
    );
    const context = buildContext({
      method: 'PUT',
      url: '/v1/analysis-jobs/aj_1/batches/1',
      mem9Context: {
        apiKeyFingerprint: Buffer.alloc(32),
        apiKeyFingerprintHex: '00',
      },
      mem9ApiKeySubject: activeSubject(),
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(rateLimitWindowService.consume).toHaveBeenCalledWith(
      '00',
      expect.anything(),
      3,
    );
  });

  it('uses the authenticated subject and never provisions tenants itself', async () => {
    const repository = createRepository();
    const rateLimitWindowService = {
      consume: jest.fn(async () => undefined),
    };
    const guard = new RateLimitGuard(
      repository as never,
      rateLimitWindowService as never,
    );
    const context = buildContext({
      method: 'GET',
      url: '/v1/taxonomy',
      mem9Context: {
        apiKeyFingerprint: Buffer.alloc(32),
        apiKeyFingerprintHex: '00',
      },
      mem9ApiKeySubject: { ...activeSubject(), planCode: 'pro' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(repository.getRateLimitPolicy).toHaveBeenCalledWith('pro');
    expect(repository.ensureApiKeySubject).not.toHaveBeenCalled();
    expect(repository.recordVerifiedApiKeySubject).not.toHaveBeenCalled();
  });

  it('rejects requests that reached it without an authenticated subject', async () => {
    const repository = createRepository();
    const rateLimitWindowService = {
      consume: jest.fn(async () => undefined),
    };
    const guard = new RateLimitGuard(
      repository as never,
      rateLimitWindowService as never,
    );
    const context = buildContext({
      method: 'GET',
      url: '/v1/taxonomy',
      mem9Context: {
        apiKeyFingerprint: Buffer.alloc(32),
        apiKeyFingerprintHex: '00',
      },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      statusCode: 401,
      code: 'API_KEY_REQUIRED',
    });
    expect(repository.ensureApiKeySubject).not.toHaveBeenCalled();
    expect(rateLimitWindowService.consume).not.toHaveBeenCalled();
  });

  it.each(['DISABLED', 'PENDING'] as const)(
    'rejects %s subjects instead of discarding their status',
    async (status) => {
      const repository = createRepository();
      const rateLimitWindowService = {
        consume: jest.fn(async () => undefined),
      };
      const guard = new RateLimitGuard(
        repository as never,
        rateLimitWindowService as never,
      );
      const context = buildContext({
        method: 'GET',
        url: '/v1/taxonomy',
        mem9Context: {
          apiKeyFingerprint: Buffer.alloc(32),
          apiKeyFingerprintHex: '00',
        },
        mem9ApiKeySubject: activeSubject(status),
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        statusCode: 403,
        code: 'API_KEY_DISABLED',
      });
      expect(rateLimitWindowService.consume).not.toHaveBeenCalled();
    },
  );
});
