import { loadApiIngressConfig, type ApiIngressConfig } from '@mem9/config';
import Fastify, { type FastifyInstance } from 'fastify';

import { installPreAuthThrottle } from './pre-auth-throttle';

describe('pre-authentication admission', () => {
  let server: FastifyInstance;
  let time: number;
  let authenticate: jest.Mock;

  function setup(overrides: Partial<ApiIngressConfig> = {}) {
    time = 0;
    const config = {
      ...loadApiIngressConfig({}),
      ipBurst: 2,
      ipRequestsPerSecond: 1,
      ...overrides,
    };
    server = Fastify({
      trustProxy: config.trustedProxyCidrs.length
        ? config.trustedProxyCidrs
        : false,
    });
    installPreAuthThrottle(server, config, () => time);
    authenticate = jest.fn();
    server.addHook('preHandler', async (request) => {
      if (request.url.startsWith('/v1/')) authenticate();
    });
    server.all('/v1/test', () => ({ ok: true }));
    server.get('/health/live', () => ({ status: 'ok' }));
    server.get('/health/ready', () => ({ status: 'ready' }));
  }

  afterEach(async () => {
    await server.close();
  });

  it('blocks rotating keys before authentication, with a retry hint and bounded recovery', async () => {
    setup();
    for (const key of ['valid', 'forged']) {
      expect(
        (
          await server.inject({
            url: '/v1/test',
            headers: { 'x-mem9-api-key': key },
          })
        ).statusCode,
      ).toBe(200);
    }
    const blocked = await server.inject({
      url: '/v1/test',
      headers: { 'x-mem9-api-key': 'another-key' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    expect(blocked.json()).toMatchObject({
      code: 'PREAUTH_RATE_LIMIT_EXCEEDED',
    });
    expect(authenticate).toHaveBeenCalledTimes(2);
    time += 1000;
    expect((await server.inject('/v1/test')).statusCode).toBe(200);
  });

  it('rejects before parsing a malformed JSON body', async () => {
    setup({ ipBurst: 1 });
    await server.inject('/v1/test');
    const blocked = await server.inject({
      method: 'POST',
      url: '/v1/test',
      headers: { 'content-type': 'application/json' },
      payload: '{broken',
    });
    expect(blocked.statusCode).toBe(429);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('ignores forged forwarding headers from direct clients', async () => {
    setup({ trustedProxyCidrs: ['10.0.0.0/24'] });
    for (let index = 1; index <= 3; index++) {
      const result = await server.inject({
        url: '/v1/test',
        remoteAddress: '198.51.100.1',
        headers: { 'x-forwarded-for': `192.0.2.${index}` },
      });
      expect(result.statusCode).toBe(index <= 2 ? 200 : 429);
    }
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it('uses the rightmost untrusted hop through the ALB, not a forged leftmost address', async () => {
    setup({ trustedProxyCidrs: ['10.0.0.0/24'] });
    for (let index = 1; index <= 3; index++) {
      const result = await server.inject({
        url: '/v1/test',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': `192.0.2.${index}, 198.51.100.1` },
      });
      expect(result.statusCode).toBe(index <= 2 ? 200 : 429);
    }
    expect(
      (
        await server.inject({
          url: '/v1/test',
          remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': '198.51.100.2' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('caps aggregate work across different client IPs', async () => {
    setup({ totalBurst: 2, totalRequestsPerSecond: 1 });
    const results = await Promise.all(
      [1, 2, 3].map((ip) =>
        server.inject({ url: '/v1/test', remoteAddress: `192.0.2.${ip}` }),
      ),
    );
    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 429]);
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it('keeps exact health probes working after business admission is exhausted', async () => {
    setup({ totalBurst: 1, totalRequestsPerSecond: 1 });
    await server.inject('/v1/test');
    for (const url of [
      '/health/live',
      '/health/ready',
      '/health/ready?check=1',
    ]) {
      expect((await server.inject(url)).statusCode).toBe(200);
    }
    expect(
      (await server.inject({ method: 'HEAD', url: '/health/ready' }))
        .statusCode,
    ).toBe(200);
    for (const url of [
      '/health/ready/anything',
      '/v1/test?probe=/health/ready',
    ]) {
      expect(
        (
          await server.inject({
            url,
            headers: { 'user-agent': 'ELB-HealthChecker/2.0' },
          })
        ).statusCode,
      ).toBe(429);
    }
    expect(
      (await server.inject({ method: 'POST', url: '/health/ready' }))
        .statusCode,
    ).toBe(429);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('fails closed at the IP-state cap and recovers after idle state expires', async () => {
    setup({ totalBurst: 10000, totalRequestsPerSecond: 10000 });
    for (let index = 0; index < 10000; index++) {
      time += 1;
      const ip = `192.0.${Math.floor(index / 256)}.${index % 256}`;
      expect(
        (await server.inject({ url: '/v1/test', remoteAddress: ip }))
          .statusCode,
      ).toBe(200);
    }
    const blocked = await server.inject({
      url: '/v1/test',
      remoteAddress: '198.51.100.1',
    });
    expect(blocked.statusCode).toBe(429);
    // Do not evict an active client's budget to admit a fresh identity.
    expect(authenticate).toHaveBeenCalledTimes(10000);
    time += 120000;
    expect(
      (await server.inject({ url: '/v1/test', remoteAddress: '198.51.100.1' }))
        .statusCode,
    ).toBe(200);
  });
});
