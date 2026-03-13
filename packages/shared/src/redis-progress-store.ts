import type {
  AggregateMergeInput,
  AggregateSnapshot,
  AnalysisEvent,
  AnalysisJobUpdatesResponse,
  BatchSummary,
  JobProgressSnapshot,
} from '@mem9/contracts';
import type Redis from 'ioredis';

import { redisKeys } from './redis-keys';

const defaultProgress = (expectedTotalBatches = 0): JobProgressSnapshot => ({
  expectedTotalBatches,
  uploadedBatches: 0,
  completedBatches: 0,
  failedBatches: 0,
  processedMemories: 0,
  resultVersion: 0,
});

const defaultAggregate = (): AggregateSnapshot => ({
  categoryCounts: {
    identity: 0,
    emotion: 0,
    preference: 0,
    experience: 0,
    activity: 0,
  },
  tagCounts: {},
  topicCounts: {},
  summarySnapshot: [],
  resultVersion: 0,
});

const mergeScript = `
  local progress = redis.call('GET', KEYS[1])
  local aggregate = redis.call('GET', KEYS[2])
  local input = cjson.decode(ARGV[1])
  local ttl = tonumber(ARGV[2])
  local progressObj = progress and cjson.decode(progress) or {
    expectedTotalBatches = input.expectedTotalBatches,
    uploadedBatches = 0,
    completedBatches = 0,
    failedBatches = 0,
    processedMemories = 0,
    resultVersion = 0
  }
  local aggregateObj = aggregate and cjson.decode(aggregate) or {
    categoryCounts = {
      identity = 0,
      emotion = 0,
      preference = 0,
      experience = 0,
      activity = 0
    },
    tagCounts = {},
    topicCounts = {},
    summarySnapshot = {},
    resultVersion = 0
  }
  progressObj.expectedTotalBatches = input.expectedTotalBatches
  progressObj.completedBatches = progressObj.completedBatches + 1
  progressObj.processedMemories = progressObj.processedMemories + input.processedMemories
  progressObj.resultVersion = progressObj.resultVersion + 1
  aggregateObj.resultVersion = progressObj.resultVersion
  aggregateObj.summarySnapshot = input.summarySnapshot
  for key, value in pairs(input.categoryCounts) do
    local existing = aggregateObj.categoryCounts[key] or 0
    aggregateObj.categoryCounts[key] = existing + value
  end
  for key, value in pairs(input.tagCounts) do
    local existing = aggregateObj.tagCounts[key] or 0
    aggregateObj.tagCounts[key] = existing + value
  end
  for key, value in pairs(input.topicCounts) do
    local existing = aggregateObj.topicCounts[key] or 0
    aggregateObj.topicCounts[key] = existing + value
  end
  local event = {
    version = progressObj.resultVersion,
    type = 'batch_completed',
    timestamp = input.timestamp,
    jobId = input.jobId,
    batchIndex = input.batchIndex,
    status = 'SUCCEEDED',
    message = input.message,
    delta = {
      processedMemories = input.processedMemories,
      completedBatches = 1,
      failedBatches = 0
    }
  }
  redis.call('SETEX', KEYS[1], ttl, cjson.encode(progressObj))
  redis.call('SETEX', KEYS[2], ttl, cjson.encode(aggregateObj))
  redis.call('SETEX', KEYS[3], ttl, cjson.encode(input.batchResult))
  redis.call('RPUSH', KEYS[4], cjson.encode(event))
  redis.call('EXPIRE', KEYS[4], ttl)
  return { cjson.encode(progressObj), cjson.encode(aggregateObj), cjson.encode(event) }
`;

export class RedisProgressStore {
  public constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  public async initializeJob(jobId: string, expectedTotalBatches: number): Promise<void> {
    await this.redis.set(
      redisKeys.jobProgress(jobId),
      JSON.stringify(defaultProgress(expectedTotalBatches)),
      'EX',
      this.ttlSeconds,
    );
    await this.redis.set(
      redisKeys.aggregate(jobId),
      JSON.stringify(defaultAggregate()),
      'EX',
      this.ttlSeconds,
    );
  }

  public async markBatchUploaded(jobId: string, batchIndex: number, expectedTotalBatches: number): Promise<void> {
    const progress = await this.getProgress(jobId, expectedTotalBatches);
    const nextUploadedBatches = Math.max(progress.uploadedBatches, batchIndex);
    const nextProgress = {
      ...progress,
      expectedTotalBatches,
      uploadedBatches: nextUploadedBatches,
    };
    const event: AnalysisEvent = {
      version: progress.resultVersion,
      type: 'batch_uploaded',
      timestamp: new Date().toISOString(),
      jobId,
      batchIndex,
      status: 'UPLOADING',
      message: `Batch ${batchIndex} uploaded`,
    };

    await this.redis.set(redisKeys.jobProgress(jobId), JSON.stringify(nextProgress), 'EX', this.ttlSeconds);
    await this.redis.rpush(redisKeys.events(jobId), JSON.stringify(event));
    await this.redis.expire(redisKeys.events(jobId), this.ttlSeconds);
  }

  public async markBatchStarted(jobId: string, batchIndex: number): Promise<void> {
    const progress = await this.getProgress(jobId);
    const event: AnalysisEvent = {
      version: progress.resultVersion,
      type: 'batch_started',
      timestamp: new Date().toISOString(),
      jobId,
      batchIndex,
      status: 'RUNNING',
      message: `Batch ${batchIndex} started`,
    };

    await this.redis.rpush(redisKeys.events(jobId), JSON.stringify(event));
    await this.redis.expire(redisKeys.events(jobId), this.ttlSeconds);
  }

  public async mergeBatch(jobId: string, input: AggregateMergeInput): Promise<{
    progress: JobProgressSnapshot;
    aggregate: AggregateSnapshot;
    event: AnalysisEvent;
  }> {
    const payload = {
      ...input,
      jobId,
      timestamp: new Date().toISOString(),
      message: `Batch ${input.batchIndex} completed`,
    };
    const [progress, aggregate, event] = (await this.redis.eval(
      mergeScript,
      4,
      redisKeys.jobProgress(jobId),
      redisKeys.aggregate(jobId),
      redisKeys.batchResult(jobId, input.batchIndex),
      redisKeys.events(jobId),
      JSON.stringify(payload),
      this.ttlSeconds.toString(),
    )) as [string, string, string];

    return {
      progress: JSON.parse(progress) as JobProgressSnapshot,
      aggregate: JSON.parse(aggregate) as AggregateSnapshot,
      event: JSON.parse(event) as AnalysisEvent,
    };
  }

  public async appendFailureEvent(jobId: string, batchIndex: number, message: string): Promise<void> {
    const progress = await this.getProgress(jobId);
    const nextProgress = {
      ...progress,
      failedBatches: progress.failedBatches + 1,
    };
    const event: AnalysisEvent = {
      version: progress.resultVersion + 1,
      type: 'batch_failed',
      timestamp: new Date().toISOString(),
      jobId,
      batchIndex,
      status: 'FAILED',
      message,
      delta: {
        failedBatches: 1,
      },
    };

    nextProgress.resultVersion = event.version;
    await this.redis.set(redisKeys.jobProgress(jobId), JSON.stringify(nextProgress), 'EX', this.ttlSeconds);
    await this.redis.rpush(redisKeys.events(jobId), JSON.stringify(event));
    await this.redis.expire(redisKeys.events(jobId), this.ttlSeconds);
  }

  public async getProgress(jobId: string, expectedTotalBatches = 0): Promise<JobProgressSnapshot> {
    const raw = await this.redis.get(redisKeys.jobProgress(jobId));
    return raw === null ? defaultProgress(expectedTotalBatches) : (JSON.parse(raw) as JobProgressSnapshot);
  }

  public async getAggregate(jobId: string): Promise<AggregateSnapshot> {
    const raw = await this.redis.get(redisKeys.aggregate(jobId));
    return raw === null ? defaultAggregate() : (JSON.parse(raw) as AggregateSnapshot);
  }

  public async getBatchResult(jobId: string, batchIndex: number): Promise<BatchSummary | null> {
    const raw = await this.redis.get(redisKeys.batchResult(jobId, batchIndex));
    return raw === null ? null : (JSON.parse(raw) as BatchSummary);
  }

  public async getUpdates(jobId: string, cursor: number): Promise<AnalysisJobUpdatesResponse> {
    const [progress, aggregate, rawEvents] = await Promise.all([
      this.getProgress(jobId),
      this.getAggregate(jobId),
      this.redis.lrange(redisKeys.events(jobId), 0, -1),
    ]);
    const events = rawEvents
      .map((value) => JSON.parse(value) as AnalysisEvent)
      .filter((event) => event.version > cursor);
    const batchResults = (
      await Promise.all(
        events
          .filter((event) => event.type === 'batch_completed' && typeof event.batchIndex === 'number')
          .map((event) => this.getBatchResult(jobId, event.batchIndex!)),
      )
    ).filter((batch): batch is BatchSummary => batch !== null);

    return {
      cursor,
      nextCursor: progress.resultVersion,
      events,
      completedBatchResults: batchResults,
      aggregate,
      progress,
    };
  }

  public async acquireLock(jobId: string, batchIndex: number, token: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(redisKeys.lock(jobId, batchIndex), token, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  public async releaseLock(jobId: string, batchIndex: number, token: string): Promise<void> {
    const lockKey = redisKeys.lock(jobId, batchIndex);
    const current = await this.redis.get(lockKey);

    if (current === token) {
      await this.redis.del(lockKey);
    }
  }

  public async extendLock(jobId: string, batchIndex: number, token: string, ttlSeconds: number): Promise<void> {
    const lockKey = redisKeys.lock(jobId, batchIndex);
    const current = await this.redis.get(lockKey);

    if (current === token) {
      await this.redis.expire(lockKey, ttlSeconds);
    }
  }

  public async markMemorySeen(jobId: string, memoryId: string, contentHash: string): Promise<boolean> {
    const results = (await this.redis
      .multi()
      .sadd(redisKeys.seenIds(jobId), memoryId)
      .expire(redisKeys.seenIds(jobId), this.ttlSeconds)
      .sadd(redisKeys.seenHashes(jobId), contentHash)
      .expire(redisKeys.seenHashes(jobId), this.ttlSeconds)
      .exec()) as [Error | null, number][] | null;

    const idAdded = (results?.[0]?.[1] ?? 0) === 1;
    const hashAdded = (results?.[2]?.[1] ?? 0) === 1;

    return idAdded && hashAdded;
  }

  public async hasBatchResult(jobId: string, batchIndex: number): Promise<boolean> {
    return (await this.redis.exists(redisKeys.batchResult(jobId, batchIndex))) === 1;
  }
}
