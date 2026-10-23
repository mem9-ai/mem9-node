import { AppError, redisKeys } from '@mem9/shared';

import { ApiKeyAuthService } from './api-key-auth.service';

const RAW_KEY = 'mk_test_valid_key';
const fingerprint = Buffer.alloc(32, 1);
const fingerprintHex = fingerprint.toString('hex');
const cacheKey = redisKeys.apiKeyVerification(fingerprintHex);

function subject(status: 'ACTIVE' | 'DISABLED' | 'PENDING' = 'ACTIVE') {
  return {
    id: 'aks_1',
    apiKeyFingerprint: new Uint8Array(fingerprint),
    status,
    planCode: 'default',
    lastSeenAt: null,
    lastVerifyAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(options: {
  existing?: ReturnType<typeof subject> | null;
  cached?: string | null;
  verifyStatus?: 'ACTIVE' | 'INACTIVE' | 'INVALID';
  verifyError?: Error;
  recorded?: ReturnType<typeof subject>;
  redisGetError?: Error;
} = {}) {
  const repository = {
    findApiKeySubject: jest.fn(async () => options.existing ?? null),
    recordVerifiedApiKeySubject: jest.fn(async () => options.recorded ?? subject('ACTIVE')),
    markApiKeySubjectSeen: jest.fn(async () => undefined),
    ensureApiKeySubject: jest.fn(),
  };
  const goVerifyService = {
    verify: jest.fn(async () => {
      if (options.verifyError) {
        throw options.verifyError;
      }
      return { status: options.verifyStatus ?? 'ACTIVE', verifiedAt: new Date() };
    }),
  };
  const redis = {
    get: jest.fn(async () => {
      if (options.redisGetError) {
        throw options.redisGetError;
      }
      return options.cached ?? null;
    }),
    set: jest.fn(async () => 'OK'),
  };
  const service = new ApiKeyAuthService(
    repository as never,
    goVerifyService as never,
    redis as never,
  );
  const authenticate = () =>
    service.authenticate({ rawApiKey: RAW_KEY, fingerprint, fingerprintHex });

  return { service, repository, goVerifyService, redis, authenticate };
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected authenticate() to throw');
}

describe('ApiKeyAuthService', () => {
  describe('forged / unknown keys', () => {
    it('rejects a key upstream does not recognise and creates no tenant', async () => {
      const ctx = setup({ verifyStatus: 'INVALID' });

      const error = await captureError(ctx.authenticate());

      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('API_KEY_INVALID');
      expect(ctx.goVerifyService.verify).toHaveBeenCalledWith(RAW_KEY);
      expect(ctx.repository.recordVerifiedApiKeySubject).not.toHaveBeenCalled();
      expect(ctx.repository.ensureApiKeySubject).not.toHaveBeenCalled();
    });

    it('negative-caches an invalid key for 60 seconds', async () => {
      const ctx = setup({ verifyStatus: 'INVALID' });

      await captureError(ctx.authenticate());

      expect(ctx.redis.set).toHaveBeenCalledWith(cacheKey, 'invalid', 'EX', 60);
    });

    it('rejects a negative-cached key without calling upstream', async () => {
      const ctx = setup({ cached: 'invalid' });

      const error = await captureError(ctx.authenticate());

      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('API_KEY_INVALID');
      expect(ctx.goVerifyService.verify).not.toHaveBeenCalled();
      expect(ctx.repository.recordVerifiedApiKeySubject).not.toHaveBeenCalled();
    });

    it('does not trust a pre-existing ACTIVE row on its own (rows auto-created before the fix)', async () => {
      const ctx = setup({ existing: subject('ACTIVE'), cached: null, verifyStatus: 'INVALID' });

      const error = await captureError(ctx.authenticate());

      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('API_KEY_INVALID');
      expect(ctx.goVerifyService.verify).toHaveBeenCalledTimes(1);
    });
  });

  describe('inactive upstream keys', () => {
    it('rejects an upstream-inactive key with 403 and caches it for 60 seconds', async () => {
      const ctx = setup({ verifyStatus: 'INACTIVE' });

      const error = await captureError(ctx.authenticate());

      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('API_KEY_INACTIVE');
      expect(ctx.repository.recordVerifiedApiKeySubject).not.toHaveBeenCalled();
      expect(ctx.redis.set).toHaveBeenCalledWith(cacheKey, 'inactive', 'EX', 60);
    });

    it('rejects a cached inactive key without calling upstream', async () => {
      const ctx = setup({ cached: 'inactive' });

      const error = await captureError(ctx.authenticate());

      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('API_KEY_INACTIVE');
      expect(ctx.goVerifyService.verify).not.toHaveBeenCalled();
    });
  });

  describe('local revocation', () => {
    it.each(['DISABLED', 'PENDING'] as const)(
      'rejects a %s subject even when upstream would accept it and the cache says active',
      async (status) => {
        const ctx = setup({ existing: subject(status), cached: 'active', verifyStatus: 'ACTIVE' });

        const error = await captureError(ctx.authenticate());

        expect(error.statusCode).toBe(403);
        expect(error.code).toBe('API_KEY_DISABLED');
        expect(ctx.goVerifyService.verify).not.toHaveBeenCalled();
        expect(ctx.repository.recordVerifiedApiKeySubject).not.toHaveBeenCalled();
      },
    );

    it('rejects when the subject was disabled between lookup and upsert', async () => {
      const ctx = setup({ existing: null, verifyStatus: 'ACTIVE', recorded: subject('DISABLED') });

      const error = await captureError(ctx.authenticate());

      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('API_KEY_DISABLED');
      expect(ctx.redis.set).not.toHaveBeenCalledWith(cacheKey, 'active', 'EX', expect.anything());
    });
  });

  describe('valid keys', () => {
    it('provisions the subject only after upstream verification and caches it for 300 seconds', async () => {
      const ctx = setup({ existing: null, verifyStatus: 'ACTIVE' });

      const result = await ctx.authenticate();

      expect(result).toMatchObject({ id: 'aks_1', status: 'ACTIVE' });
      expect(ctx.goVerifyService.verify).toHaveBeenCalledWith(RAW_KEY);
      expect(ctx.repository.recordVerifiedApiKeySubject).toHaveBeenCalledWith(
        fingerprint,
        expect.any(Date),
      );
      expect(ctx.redis.set).toHaveBeenCalledWith(cacheKey, 'active', 'EX', 300);
    });

    it('serves a cached active key with an ACTIVE subject without calling upstream', async () => {
      const ctx = setup({ existing: subject('ACTIVE'), cached: 'active' });

      const result = await ctx.authenticate();

      expect(result).toMatchObject({ id: 'aks_1' });
      expect(ctx.goVerifyService.verify).not.toHaveBeenCalled();
      expect(ctx.repository.markApiKeySubjectSeen).toHaveBeenCalledWith('aks_1');
    });

    it('re-verifies when the cache says active but no subject row exists', async () => {
      const ctx = setup({ existing: null, cached: 'active', verifyStatus: 'ACTIVE' });

      await ctx.authenticate();

      expect(ctx.goVerifyService.verify).toHaveBeenCalledTimes(1);
      expect(ctx.repository.recordVerifiedApiKeySubject).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure modes', () => {
    it('fails closed (503) when upstream verification is unavailable and creates no tenant', async () => {
      const ctx = setup({
        verifyError: new AppError('unavailable', {
          statusCode: 503,
          code: 'API_KEY_VERIFY_UNAVAILABLE',
        }),
      });

      const error = await captureError(ctx.authenticate());

      expect(error.statusCode).toBe(503);
      expect(error.code).toBe('API_KEY_VERIFY_UNAVAILABLE');
      expect(ctx.repository.recordVerifiedApiKeySubject).not.toHaveBeenCalled();
      expect(ctx.redis.set).not.toHaveBeenCalled();
    });

    it('treats a Redis read failure as a cache miss, still verifying upstream', async () => {
      const ctx = setup({ redisGetError: new Error('redis down'), verifyStatus: 'INVALID' });

      const error = await captureError(ctx.authenticate());

      expect(error.statusCode).toBe(401);
      expect(ctx.goVerifyService.verify).toHaveBeenCalledTimes(1);
    });

    it('ignores unknown cache values and verifies upstream', async () => {
      const ctx = setup({ cached: 'something-else', verifyStatus: 'INVALID' });

      await captureError(ctx.authenticate());

      expect(ctx.goVerifyService.verify).toHaveBeenCalledTimes(1);
    });
  });
});
