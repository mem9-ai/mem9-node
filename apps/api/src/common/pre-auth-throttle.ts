import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

import type { ApiIngressConfig } from '@mem9/config';
import type { FastifyInstance } from 'fastify';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const MAX_IP_BUCKETS = 10000;

// Per-process admission budget. Existing Redis-backed tenant quotas still apply
// after authentication. No unauthenticated request performs Redis I/O here.
export function installPreAuthThrottle(
  server: FastifyInstance,
  config: ApiIngressConfig,
  now: () => number = () => performance.now(),
): void {
  const buckets = new Map<string, Bucket>();
  const total: Bucket = { tokens: config.totalBurst, updatedAt: now() };
  const idleTtl = Math.max(
    60000,
    (config.ipBurst / config.ipRequestsPerSecond) * 1000,
  );
  let nextCleanup = now() + idleTtl;

  const refill = (
    bucket: Bucket,
    capacity: number,
    rate: number,
    time: number,
  ) => {
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + (Math.max(0, time - bucket.updatedAt) * rate) / 1000,
    );
    bucket.updatedAt = time;
  };

  server.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0];
    // Only these cheap/single-flight GET probes bypass business admission. Never
    // trust a health-check User-Agent or a prefix such as /health/*.
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      (path === '/health/live' || path === '/health/ready')
    )
      return;

    const time = now();
    refill(total, config.totalBurst, config.totalRequestsPerSecond, time);
    let retryAfterMs =
      total.tokens < 1
        ? ((1 - total.tokens) / config.totalRequestsPerSecond) * 1000
        : 0;

    // Fastify resolves this from the socket unless its peer is in the explicit
    // proxy allowlist. Malformed forwarded IPs all share a single bounded bucket.
    const rawIp = request.ip;
    let ip = 'unknown';
    if (isIP(rawIp) === 4) ip = rawIp;
    if (isIP(rawIp) === 6) ip = new URL(`http://[${rawIp}]`).hostname;

    if (time >= nextCleanup) {
      for (const [key, bucket] of buckets) {
        if (time - bucket.updatedAt >= idleTtl) buckets.delete(key);
      }
      nextCleanup = time + idleTtl;
    }

    // Once the global budget is exhausted, do not allocate more per-IP state.
    if (retryAfterMs === 0) {
      let bucket = buckets.get(ip);
      if (!bucket && buckets.size >= MAX_IP_BUCKETS) {
        retryAfterMs = nextCleanup - time;
      } else {
        if (!bucket) {
          bucket = { tokens: config.ipBurst, updatedAt: time };
          buckets.set(ip, bucket);
        }
        refill(bucket, config.ipBurst, config.ipRequestsPerSecond, time);
        if (bucket.tokens < 1) {
          retryAfterMs =
            ((1 - bucket.tokens) / config.ipRequestsPerSecond) * 1000;
        } else {
          bucket.tokens -= 1;
          total.tokens -= 1;
          return;
        }
      }
    }

    return reply
      .code(429)
      .header(
        'retry-after',
        String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      )
      .header('cache-control', 'no-store')
      .send({
        code: 'PREAUTH_RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please retry later.',
        requestId: request.id,
      });
  });
}
