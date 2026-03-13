import { RateLimitWindowService } from './rate-limit';

class FakeRedis {
  private readonly values = new Map<string, number>();

  public multi(): {
    incrby(key: string, amount: number): ReturnType<FakeRedis['multi']>;
    expire(key: string, ttl: number): ReturnType<FakeRedis['multi']>;
    exec(): Promise<[null, number][]>;
  } {
    const results: [null, number][] = [];
    return {
      incrby: (key: string, amount: number) => {
        const next = (this.values.get(key) ?? 0) + amount;
        this.values.set(key, next);
        results.push([null, next]);
        return this.multiProxy(results);
      },
      expire: (key: string, ttl: number) => {
        void key;
        void ttl;
        results.push([null, 1]);
        return this.multiProxy(results);
      },
      exec: async () => results,
    };
  }

  private multiProxy(results: [null, number][]): {
    incrby(key: string, amount: number): ReturnType<FakeRedis['multi']>;
    expire(key: string, ttl: number): ReturnType<FakeRedis['multi']>;
    exec(): Promise<[null, number][]>;
  } {
    return {
      incrby: (key: string, amount: number) => {
        const next = (this.values.get(key) ?? 0) + amount;
        this.values.set(key, next);
        results.push([null, next]);
        return this.multiProxy(results);
      },
      expire: (key: string, ttl: number) => {
        void key;
        void ttl;
        results.push([null, 1]);
        return this.multiProxy(results);
      },
      exec: async () => results,
    };
  }
}

describe('rate limit window service', () => {
  it('allows requests within the configured window', async () => {
    const service = new RateLimitWindowService(new FakeRedis() as never);

    await expect(
      service.consume(
        'abc',
        {
          rpmLimit: 10,
          dailyLimit: 20,
        },
        1,
        new Date('2026-03-01T00:00:00.000Z'),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects requests when minute limit is exceeded', async () => {
    const service = new RateLimitWindowService(new FakeRedis() as never);

    await service.consume(
      'abc',
      {
        rpmLimit: 1,
        dailyLimit: 20,
      },
      1,
      new Date('2026-03-01T00:00:00.000Z'),
    );

    await expect(
      service.consume(
        'abc',
        {
          rpmLimit: 1,
          dailyLimit: 20,
        },
        1,
        new Date('2026-03-01T00:00:10.000Z'),
      ),
    ).rejects.toThrow('Rate limit exceeded');
  });
});
