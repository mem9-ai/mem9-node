import { AppError, deriveApiKeyFingerprint, fingerprintToHex } from '@mem9/shared';
import type { ExecutionContext } from '@nestjs/common';

import { ApiKeyGuard } from './api-key.guard';
import type { Mem9FastifyRequest } from './request-context';

const PEPPER = 'guard-spec-pepper-1234567890';

function buildContext(headers: Record<string, string | string[] | undefined>) {
  const request = { id: 'req_1', headers } as unknown as Mem9FastifyRequest;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
  return { request, context };
}

function setup(result: unknown = { id: 'aks_1', status: 'ACTIVE', planCode: 'default' }) {
  const apiKeyAuthService = {
    authenticate: jest.fn(async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }),
  };
  const guard = new ApiKeyGuard(apiKeyAuthService as never);
  return { guard, apiKeyAuthService };
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected canActivate() to throw');
}

describe('ApiKeyGuard', () => {
  const originalPepper = process.env.APP_PEPPER;

  beforeEach(() => {
    process.env.APP_PEPPER = PEPPER;
  });

  afterAll(() => {
    process.env.APP_PEPPER = originalPepper;
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('rejects a %s header with 401 API_KEY_REQUIRED', async (_label, value) => {
    const { guard, apiKeyAuthService } = setup();
    const { context } = buildContext({ 'x-mem9-api-key': value });

    const error = await captureError(Promise.resolve(guard.canActivate(context)));

    expect(error.statusCode).toBe(401);
    expect(error.code).toBe('API_KEY_REQUIRED');
    expect(apiKeyAuthService.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    ['too long', 'k'.repeat(257)],
    ['contains a space', 'abc def'],
    ['contains a control char', 'abc\u0000def'],
    ['contains a newline', 'abc\ndef'],
    ['non-ASCII', 'clé-secrète'],
  ])('rejects a malformed key (%s) with 401 before any lookup', async (_label, value) => {
    const { guard, apiKeyAuthService } = setup();
    const { context } = buildContext({ 'x-mem9-api-key': value });

    const error = await captureError(Promise.resolve(guard.canActivate(context)));

    expect(error.statusCode).toBe(401);
    expect(error.code).toBe('API_KEY_INVALID');
    expect(apiKeyAuthService.authenticate).not.toHaveBeenCalled();
  });

  it('accepts a 256-character printable key', async () => {
    const { guard, apiKeyAuthService } = setup();
    const { context } = buildContext({ 'x-mem9-api-key': 'k'.repeat(256) });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyAuthService.authenticate).toHaveBeenCalledTimes(1);
  });

  it('does not admit the request when authentication rejects the key', async () => {
    const { guard } = setup(
      new AppError('Invalid API key', { statusCode: 401, code: 'API_KEY_INVALID' }),
    );
    const { context, request } = buildContext({ 'x-mem9-api-key': 'forged-key' });

    const error = await captureError(Promise.resolve(guard.canActivate(context)));

    expect(error.statusCode).toBe(401);
    expect(request.mem9Context).toBeUndefined();
    expect(request.mem9ApiKeySubject).toBeUndefined();
  });

  it('passes the unchanged fingerprint to authentication and populates the request', async () => {
    const subject = { id: 'aks_1', status: 'ACTIVE', planCode: 'default' };
    const { guard, apiKeyAuthService } = setup(subject);
    const { context, request } = buildContext({ 'x-mem9-api-key': 'mk_valid_key' });
    const expectedFingerprint = deriveApiKeyFingerprint(PEPPER, 'mk_valid_key');

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(apiKeyAuthService.authenticate).toHaveBeenCalledWith({
      rawApiKey: 'mk_valid_key',
      fingerprint: expectedFingerprint,
      fingerprintHex: fingerprintToHex(expectedFingerprint),
    });
    expect(request.mem9Context).toEqual({
      apiKeyFingerprint: expectedFingerprint,
      apiKeyFingerprintHex: fingerprintToHex(expectedFingerprint),
      rawApiKey: 'mk_valid_key',
      requestId: 'req_1',
    });
    expect(request.mem9ApiKeySubject).toBe(subject);
  });

  it('uses the first value when the header is repeated', async () => {
    const { guard, apiKeyAuthService } = setup();
    const { context } = buildContext({ 'x-mem9-api-key': ['first-key', 'second-key'] });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyAuthService.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ rawApiKey: 'first-key' }),
    );
  });
});
