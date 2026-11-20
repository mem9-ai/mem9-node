import { ServiceUnavailableException } from '@nestjs/common';

import { HealthService } from './health.service';

jest.mock('node:perf_hooks', () => ({
  performance: { now: () => Date.now() },
}));

describe('bounded readiness probes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function setup() {
    const prisma = {
      $queryRawUnsafe: jest
        .fn<Promise<unknown>, [string]>()
        .mockResolvedValue([]),
    };
    const redis = {
      ping: jest.fn<Promise<string>, []>().mockResolvedValue('PONG'),
    };
    return {
      prisma,
      redis,
      service: new HealthService(prisma as never, redis as never),
    };
  }

  it('coalesces concurrent probes, caches success for one second, and then refreshes', async () => {
    const { prisma, redis, service } = setup();
    await Promise.all(
      Array.from({ length: 100 }, () => service.getReadiness()),
    );
    await service.getReadiness();
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(service.getReadiness()).resolves.toEqual({ status: 'ready' });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it.each(['mysql', 'redis'])(
    'caches a %s failure and reports 503, then recovers',
    async (dependency) => {
      const { prisma, redis, service } = setup();
      if (dependency === 'mysql')
        prisma.$queryRawUnsafe.mockRejectedValueOnce(
          new Error('database unavailable'),
        );
      else redis.ping.mockRejectedValueOnce(new Error('redis unavailable'));
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, () => service.getReadiness()),
      );
      expect(results.every((result) => result.status === 'rejected')).toBe(
        true,
      );
      await expect(service.getReadiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1000);
      await expect(service.getReadiness()).resolves.toEqual({
        status: 'ready',
      });
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    },
  );

  it('bounds response time without starting replacement queries while a dependency hangs', async () => {
    const { prisma, redis, service } = setup();
    let finish: (value: unknown) => void = () => undefined;
    prisma.$queryRawUnsafe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const failed = expect(service.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await jest.advanceTimersByTimeAsync(2000);
    await failed;
    await jest.advanceTimersByTimeAsync(1000);
    const retry = expect(service.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await jest.advanceTimersByTimeAsync(2000);
    await retry;
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(redis.ping).not.toHaveBeenCalled();
    finish([]);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(service.getReadiness()).resolves.toEqual({ status: 'ready' });
  });

  it('does not touch dependencies for liveness', async () => {
    const { prisma, redis, service } = setup();
    await expect(service.getLiveness()).resolves.toEqual({ status: 'ok' });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });
});
