import type { AppConfig } from '@mem9/config';

import { AppError } from './errors';
import { GoVerifyService } from './go-verify.service';

const RAW_KEY = 'mk_live_super_secret_key_value';

function createService(mode: AppConfig['goVerify']['mode'] = 'remote') {
  return new GoVerifyService({
    goVerify: {
      mode,
      baseUrl: 'https://mem9.example.test/',
      sharedSecret: 'test-secret',
      timeoutMs: 3000,
    },
  } as AppConfig);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected verify() to throw');
}

describe('GoVerifyService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('noop mode returns ACTIVE without calling upstream', async () => {
    const result = await createService('noop').verify(RAW_KEY);

    expect(result.status).toBe('ACTIVE');
    expect(result.verifiedAt).toBeInstanceOf(Date);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the upstream key status endpoint with the raw key in X-API-Key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'active' }));

    await createService().verify(RAW_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mem9.example.test/v1alpha2/status');
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(new Headers(init.headers).get('x-api-key')).toBe(RAW_KEY);
    expect(init.signal).toBeDefined();
    // A redirect must not forward X-API-Key to another host.
    expect(init.redirect).toBe('error');
    // The key must never be placed in the URL.
    expect(url).not.toContain(RAW_KEY);
  });

  it('maps an upstream active status to ACTIVE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'active' }));

    await expect(createService().verify(RAW_KEY)).resolves.toMatchObject({
      status: 'ACTIVE',
    });
  });

  it('maps an upstream inactive status to INACTIVE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'inactive' }));

    await expect(createService().verify(RAW_KEY)).resolves.toMatchObject({
      status: 'INACTIVE',
    });
  });

  it.each([400, 401, 403, 404])(
    'maps upstream %i to INVALID',
    async (status) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(status, { error: 'key not found' }));

      await expect(createService().verify(RAW_KEY)).resolves.toMatchObject({
        status: 'INVALID',
      });
    },
  );

  it.each([500, 502, 503, 429])(
    'fails closed with 503 when upstream returns %i',
    async (status) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(status, { error: 'down' }));

      const error = await captureError(createService().verify(RAW_KEY));
      expect(error.statusCode).toBe(503);
      expect(error.code).toBe('API_KEY_VERIFY_UNAVAILABLE');
    },
  );

  it('fails closed when upstream returns an unexpected status value', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'ACTIVE-ish' }));

    const error = await captureError(createService().verify(RAW_KEY));
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('API_KEY_VERIFY_UNAVAILABLE');
  });

  it('fails closed when upstream returns a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>ok</html>', { status: 200 }));

    const error = await captureError(createService().verify(RAW_KEY));
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('API_KEY_VERIFY_UNAVAILABLE');
  });

  it('fails closed on network errors and timeouts without leaking the key', async () => {
    const abortError = new Error(`aborted while verifying ${RAW_KEY}`);
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const error = await captureError(createService().verify(RAW_KEY));
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('API_KEY_VERIFY_UNAVAILABLE');
    expect(error.message).not.toContain(RAW_KEY);
    expect(JSON.stringify(error.details ?? {})).not.toContain(RAW_KEY);
  });

  it('does not retry, so one request costs at most one upstream call', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));

    await captureError(createService().verify(RAW_KEY));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
