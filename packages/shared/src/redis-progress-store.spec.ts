import { RedisProgressStore } from './redis-progress-store';

const legacyCategories = ['identity', 'emotion', 'preference', 'experience', 'activity'] as const;

interface FakeProgressState {
  expectedTotalBatches: number;
  uploadedBatches: number;
  completedBatches: number;
  failedBatches: number;
  processedMemories: number;
  resultVersion: number;
}

interface FakeAggregateState {
  categoryCounts: Record<string, number>;
  tagCounts: Record<string, number>;
  topicCounts: Record<string, number>;
  summarySnapshot: string[];
  resultVersion: number;
}

class FakeRedis {
  private readonly values = new Map<string, string>();
  private readonly lists = new Map<string, string[]>();
  private readonly sets = new Map<string, Set<string>>();

  public async set(key: string, value: string): Promise<string> {
    this.values.set(key, value);
    return 'OK';
  }

  public async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  public async rpush(key: string, value: string): Promise<number> {
    const current = this.lists.get(key) ?? [];
    current.push(value);
    this.lists.set(key, current);
    return current.length;
  }

  public async lrange(key: string): Promise<string[]> {
    return this.lists.get(key) ?? [];
  }

  public async expire(): Promise<number> {
    return 1;
  }

  public async eval(_script: string, _keyCount: number, progressKey: string, aggregateKey: string, batchKey: string, eventsKey: string, payload: string): Promise<[string, string, string]> {
    const input = JSON.parse(payload) as {
      expectedTotalBatches: number;
      processedMemories: number;
      categoryCounts: Record<string, number>;
      tagCounts: Record<string, number>;
      topicCounts: Record<string, number>;
      summarySnapshot: string[];
      batchResult: Record<string, unknown>;
      batchIndex: number;
      jobId: string;
      timestamp: string;
      message: string;
    };
    const progress = JSON.parse(
      (await this.get(progressKey)) ??
        '{"expectedTotalBatches":0,"uploadedBatches":0,"completedBatches":0,"failedBatches":0,"processedMemories":0,"resultVersion":0}',
    ) as FakeProgressState;
    const aggregate = JSON.parse(
      (await this.get(aggregateKey)) ??
        '{"categoryCounts":{},"tagCounts":{},"topicCounts":{},"summarySnapshot":[],"resultVersion":0}',
    ) as FakeAggregateState;

    progress.expectedTotalBatches = input.expectedTotalBatches;
    progress.completedBatches += 1;
    progress.processedMemories += input.processedMemories;
    progress.resultVersion += 1;
    aggregate.resultVersion = progress.resultVersion;
    aggregate.summarySnapshot = input.summarySnapshot;

    for (const [key, value] of Object.entries(input.categoryCounts)) {
      aggregate.categoryCounts[key] = (aggregate.categoryCounts[key] ?? 0) + value;
    }

    for (const [key, value] of Object.entries(input.tagCounts)) {
      aggregate.tagCounts[key] = (aggregate.tagCounts[key] ?? 0) + value;
    }

    for (const [key, value] of Object.entries(input.topicCounts)) {
      aggregate.topicCounts[key] = (aggregate.topicCounts[key] ?? 0) + value;
    }

    const event = {
      version: progress.resultVersion,
      type: 'batch_completed',
      timestamp: input.timestamp,
      jobId: input.jobId,
      batchIndex: input.batchIndex,
      status: 'SUCCEEDED',
      message: input.message,
      delta: {
        processedMemories: input.processedMemories,
        completedBatches: 1,
        failedBatches: 0,
      },
    };

    await this.set(progressKey, JSON.stringify(progress));
    await this.set(aggregateKey, JSON.stringify(aggregate));
    await this.set(batchKey, JSON.stringify(input.batchResult));
    await this.rpush(eventsKey, JSON.stringify(event));

    return [JSON.stringify(progress), JSON.stringify(aggregate), JSON.stringify(event)];
  }

  public multi(): {
    sadd(key: string, value: string): ReturnType<FakeRedis['multi']>;
    expire(key: string, seconds: number): ReturnType<FakeRedis['multi']>;
    exec(): Promise<[null, number][]>;
  } {
    const operations: (() => number)[] = [];

    return {
      sadd: (key: string, value: string) => {
        operations.push(() => {
          const current = this.sets.get(key) ?? new Set<string>();
          const sizeBefore = current.size;
          current.add(value);
          this.sets.set(key, current);
          return current.size > sizeBefore ? 1 : 0;
        });
        return this.multiProxy(operations);
      },
      expire: (key: string, seconds: number) => {
        void key;
        void seconds;
        operations.push(() => 1);
        return this.multiProxy(operations);
      },
      exec: async () => operations.map((operation) => [null, operation()]),
    };
  }

  private multiProxy(operations: (() => number)[]): {
    sadd(key: string, value: string): ReturnType<FakeRedis['multi']>;
    expire(key: string, seconds: number): ReturnType<FakeRedis['multi']>;
    exec(): Promise<[null, number][]>;
  } {
    return {
      sadd: (key: string, value: string) => {
        operations.push(() => {
          const current = this.sets.get(key) ?? new Set<string>();
          const sizeBefore = current.size;
          current.add(value);
          this.sets.set(key, current);
          return current.size > sizeBefore ? 1 : 0;
        });
        return this.multiProxy(operations);
      },
      expire: (key: string, seconds: number) => {
        void key;
        void seconds;
        operations.push(() => 1);
        return this.multiProxy(operations);
      },
      exec: async () => operations.map((operation) => [null, operation()]),
    };
  }

  public async exists(key: string): Promise<number> {
    return this.values.has(key) ? 1 : 0;
  }

  public async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

describe('redis progress store', () => {
  it('merges aggregate deltas atomically', async () => {
    const store = new RedisProgressStore(new FakeRedis() as never, 60);

    await store.initializeJob('aj_1', 3, legacyCategories);
    const result = await store.mergeBatch('aj_1', {
      batchIndex: 1,
      expectedTotalBatches: 3,
      processedMemories: 2,
      categoryCounts: {
        identity: 1,
        emotion: 1,
        preference: 0,
        experience: 0,
        activity: 0,
      },
      tagCounts: { ai: 2 },
      topicCounts: { ai: 2 },
      summarySnapshot: ['identity:1', 'emotion:1'],
      batchResult: {
        batchIndex: 1,
        status: 'SUCCEEDED',
        memoryCount: 2,
        processedMemories: 2,
        topCategories: [],
        topTags: ['ai'],
      },
    });

    expect(result.progress.completedBatches).toBe(1);
    expect(result.aggregate.categoryCounts.identity).toBe(1);
    expect(result.aggregate.tagCounts.ai).toBe(2);
    expect(result.event.type).toBe('batch_completed');
  });

  it('deduplicates seen memory ids and hashes', async () => {
    const store = new RedisProgressStore(new FakeRedis() as never, 60);

    await store.initializeJob('aj_1', 1, legacyCategories);

    expect(await store.markMemorySeen('aj_1', 'm1', 'h1')).toBe(true);
    expect(await store.markMemorySeen('aj_1', 'm1', 'h1')).toBe(false);
  });

  it('supports dynamic category initialization for v3 taxonomies', async () => {
    const store = new RedisProgressStore(new FakeRedis() as never, 60);
    const categories = ['policy', 'project', 'debugging'];

    await store.initializeJob('aj_v3', 1, categories);

    const aggregate = await store.getAggregate('aj_v3');

    expect(aggregate.categoryCounts).toEqual({
      policy: 0,
      project: 0,
      debugging: 0,
    });
  });
});
