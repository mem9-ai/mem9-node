import Fastify from 'fastify';

import { resolveRequestId } from './request-id';

describe('request ID boundary', () => {
  it.each(['request-123', 'a'.repeat(64), 'trace:1.2_3'])(
    'preserves supported IDs (%s)',
    (value) => {
      expect(resolveRequestId(value)).toBe(value);
    },
  );
  it.each([
    undefined,
    '',
    'a'.repeat(65),
    'unsafe\nvalue',
    ['one', 'two'],
    '你好',
  ])('generates safe IDs for malformed input %#', (value) => {
    expect(resolveRequestId(value)).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('prevents Fastify from bypassing validation with the request ID header', async () => {
    const app = Fastify({
      requestIdHeader: false,
      genReqId: (request) => resolveRequestId(request.headers['x-request-id']),
    });
    app.get('/', (request) => ({ requestId: request.id }));
    try {
      const valid = await app.inject({
        url: '/',
        headers: { 'x-request-id': 'trace-123' },
      });
      expect(valid.json()).toEqual({ requestId: 'trace-123' });
      const invalid = await app.inject({
        url: '/',
        headers: { 'x-request-id': 'x'.repeat(1000) },
      });
      expect(invalid.statusCode).toBe(200);
      expect(invalid.json<{ requestId: string }>().requestId).toMatch(/^[a-f0-9-]{36}$/);
    } finally {
      await app.close();
    }
  });
});
