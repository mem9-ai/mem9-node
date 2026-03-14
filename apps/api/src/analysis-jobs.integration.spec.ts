import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type {
  AnalysisJobSnapshotResponse,
  AnalysisJobUpdatesResponse,
  CreateAnalysisJobResponse,
} from '@mem9/contracts';
import {
  AnalysisRepository,
  GoVerifyService,
  RateLimitWindowService,
  RedisProgressStore,
  RedisService,
  S3PayloadStorageService,
  SqsQueueService,
  TaxonomyCacheService,
} from '@mem9/shared';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AnalysisJobStatus, AnalysisJobBatchStatus } from '@prisma/client';
import request from 'supertest';

import { AnalysisJobsController } from './analysis-jobs.controller';
import { AnalysisJobsService } from './analysis-jobs.service';
import { ApiKeyGuard } from './common/api-key.guard';
import { AppExceptionFilter } from './common/app-exception.filter';
import { RateLimitGuard } from './common/rate-limit.guard';

interface FakeJob {
  id: string;
  apiKeyFingerprint: Uint8Array<ArrayBuffer>;
  status: AnalysisJobStatus;
  dateRangeStart: Date;
  dateRangeEnd: Date;
  expectedTotalMemories: number;
  expectedTotalBatches: number;
  uploadedBatches: number;
  completedBatches: number;
  failedBatches: number;
  processedMemories: number;
  batchSize: number;
  pipelineVersion: string;
  taxonomyVersion: string;
  llmEnabled: boolean;
  resultVersion: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  batches: FakeBatch[];
}

interface FakeBatch {
  id: string;
  jobId: string;
  batchIndex: number;
  status: AnalysisJobBatchStatus;
  memoryCount: number;
  payloadHash: string;
  payloadObjectKey: string;
  attemptCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  resultCacheKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
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

  public async eval(
    _script: string,
    _keyCount: number,
    progressKey: string,
    aggregateKey: string,
    batchKey: string,
    eventsKey: string,
    payload: string,
  ): Promise<[string, string, string]> {
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
    ) as {
      expectedTotalBatches: number;
      uploadedBatches: number;
      completedBatches: number;
      failedBatches: number;
      processedMemories: number;
      resultVersion: number;
    };
    const aggregate = JSON.parse(
      (await this.get(aggregateKey)) ??
        '{"categoryCounts":{"identity":0,"emotion":0,"preference":0,"experience":0,"activity":0},"tagCounts":{},"topicCounts":{},"summarySnapshot":[],"resultVersion":0}',
    ) as {
      categoryCounts: Record<string, number>;
      tagCounts: Record<string, number>;
      topicCounts: Record<string, number>;
      summarySnapshot: string[];
      resultVersion: number;
    };

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
    expire(key: string, ttl: number): ReturnType<FakeRedis['multi']>;
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
      expire: (key: string, ttl: number) => {
        void key;
        void ttl;
        operations.push(() => 1);
        return this.multiProxy(operations);
      },
      exec: async () => operations.map((operation) => [null, operation()]),
    };
  }

  private multiProxy(operations: (() => number)[]): {
    sadd(key: string, value: string): ReturnType<FakeRedis['multi']>;
    expire(key: string, ttl: number): ReturnType<FakeRedis['multi']>;
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
      expire: (key: string, ttl: number) => {
        void key;
        void ttl;
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

class FakeRepository {
  public readonly jobs = new Map<string, FakeJob>();
  public readonly subjects = new Map<string, { planCode: string }>();

  public async ensureApiKeySubject(fingerprint: Buffer) {
    const key = fingerprint.toString('hex');
    if (!this.subjects.has(key)) {
      this.subjects.set(key, { planCode: 'default' });
    }

    return {
      id: 'aks_1',
      apiKeyFingerprint: new Uint8Array(fingerprint.buffer.slice(fingerprint.byteOffset, fingerprint.byteOffset + fingerprint.byteLength) as ArrayBuffer),
      status: 'ACTIVE',
      planCode: 'default',
      lastSeenAt: new Date(),
      lastVerifyAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  public async getRateLimitPolicy() {
    return {
      id: 'rlp_1',
      planCode: 'default',
      rpmLimit: 1000,
      dailyLimit: 100000,
      burstLimit: 100,
      maxActiveJobs: 10,
      maxBatchesPerJob: 100,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  public async countActiveJobs(): Promise<number> {
    return 0;
  }

  public async getPipelineConfig() {
    return {
      id: 'apc_1',
      version: 'v1',
      maxMemoriesPerRequest: 100,
      maxBodyBytes: 524288,
      resultCacheEnabled: true,
      llmFallbackEnabled: false,
      defaultBatchSize: 100,
      partialResultTtlSeconds: 86400,
      payloadRetentionDays: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  public async createJob(data: {
    fingerprint: Buffer;
    dateRangeStart: Date;
    dateRangeEnd: Date;
    expectedTotalMemories: number;
    expectedTotalBatches: number;
    batchSize: number;
    pipelineVersion: string;
    taxonomyVersion: string;
    llmEnabled: boolean;
    expiresAt: Date;
  }) {
    const job: FakeJob = {
      id: 'aj_test_1',
      apiKeyFingerprint: new Uint8Array(data.fingerprint.buffer.slice(data.fingerprint.byteOffset, data.fingerprint.byteOffset + data.fingerprint.byteLength) as ArrayBuffer),
      status: 'UPLOADING',
      dateRangeStart: data.dateRangeStart,
      dateRangeEnd: data.dateRangeEnd,
      expectedTotalMemories: data.expectedTotalMemories,
      expectedTotalBatches: data.expectedTotalBatches,
      uploadedBatches: 0,
      completedBatches: 0,
      failedBatches: 0,
      processedMemories: 0,
      batchSize: data.batchSize,
      pipelineVersion: data.pipelineVersion,
      taxonomyVersion: data.taxonomyVersion,
      llmEnabled: data.llmEnabled,
      resultVersion: 0,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      expiresAt: data.expiresAt,
      lastErrorCode: null,
      lastErrorMessage: null,
      batches: [],
    };
    this.jobs.set(job.id, job);
    return job;
  }

  public async getOwnedJob(jobId: string): Promise<FakeJob> {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error('job not found');
    }

    return job;
  }

  public async upsertUploadedBatch(data: {
    jobId: string;
    batchIndex: number;
    memoryCount: number;
    payloadHash: string;
    payloadObjectKey: string;
  }) {
    const job = this.jobs.get(data.jobId);
    if (job === undefined) {
      throw new Error('job not found');
    }

    const batch: FakeBatch = {
      id: `ajb_${data.batchIndex}`,
      jobId: data.jobId,
      batchIndex: data.batchIndex,
      status: 'QUEUED',
      memoryCount: data.memoryCount,
      payloadHash: data.payloadHash,
      payloadObjectKey: data.payloadObjectKey,
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      resultCacheKey: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    job.batches.push(batch);
    job.uploadedBatches += 1;
    return {
      batch,
      isNewUpload: true,
    };
  }

  public async markJobFinalized(jobId: string): Promise<FakeJob> {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error('job not found');
    }
    job.status = 'PROCESSING';
    job.startedAt = new Date();
    return job;
  }

  public async cancelJob(jobId: string): Promise<FakeJob> {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error('job not found');
    }
    job.status = 'CANCELLED';
    return job;
  }
}

describe('analysis jobs integration', () => {
  let app: NestFastifyApplication;
  let redis: FakeRedis;

  beforeAll(async () => {
    process.env.APP_PEPPER = 'integration-pepper-123456789';
    redis = new FakeRedis();

    const moduleRef = await Test.createTestingModule({
      controllers: [AnalysisJobsController],
      providers: [
        AnalysisJobsService,
        ApiKeyGuard,
        RateLimitGuard,
        {
          provide: APP_CONFIG,
          useValue: {
            app: {
              env: 'test',
              port: 3000,
              workerHealthPort: 3001,
              logLevel: 'info',
              pepper: process.env.APP_PEPPER,
            },
            database: {
              url: 'mysql://test',
            },
            redis: {
              url: 'redis://test',
            },
            aws: {
              region: 'us-east-1',
              endpointUrl: 'http://127.0.0.1:4566',
              accessKeyId: 'test',
              secretAccessKey: 'test',
              forcePathStyle: true,
              s3BucketAnalysisPayloads: 'mem9-analysis-payloads',
              sqsAnalysisBatchQueueUrl: 'analysis-batch',
              sqsAnalysisBatchDlqUrl: 'analysis-batch-dlq',
              sqsAnalysisLlmQueueUrl: 'analysis-llm',
              sqsAnalysisLlmDlqUrl: 'analysis-llm-dlq',
            },
            analysis: {
              jobResultTtlSeconds: 86400,
              payloadRetentionDays: 7,
              defaultBatchSize: 100,
              maxBatchMemories: 100,
              maxBatchBytes: 524288,
              maxMemoriesPerRequest: 100,
              pipelineVersion: 'v1',
              taxonomyVersion: 'v1',
            },
            goVerify: {
              mode: 'noop',
              baseUrl: 'http://127.0.0.1:8080',
              sharedSecret: 'test-secret',
            },
            sqs: {
              waitTimeSeconds: 10,
              visibilityTimeoutSeconds: 30,
              visibilityHeartbeatSeconds: 10,
            },
          } satisfies AppConfig,
        },
        {
          provide: AnalysisRepository,
          useClass: FakeRepository,
        },
        {
          provide: S3PayloadStorageService,
          useValue: {
            putCompressedJson: jest.fn(async () => undefined),
          },
        },
        {
          provide: SqsQueueService,
          useValue: {
            enqueueBatch: jest.fn(async () => undefined),
          },
        },
        {
          provide: TaxonomyCacheService,
          useValue: {
            getResponse: jest.fn(async () => ({
              version: 'v1',
              updatedAt: new Date().toISOString(),
              categories: ['identity', 'emotion', 'preference', 'experience', 'activity'],
              rules: [],
            })),
          },
        },
        {
          provide: GoVerifyService,
          useValue: {
            verify: jest.fn(async () => ({
              status: 'ACTIVE',
              planCode: 'default',
              verifiedAt: new Date(),
            })),
          },
        },
        {
          provide: RateLimitWindowService,
          useValue: {
            consume: jest.fn(async () => undefined),
          },
        },
        {
          provide: RedisService,
          useValue: redis,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a job, uploads a batch, and returns updates after a simulated worker merge', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/v1/analysis-jobs')
      .set('x-mem9-api-key', 'mem9-secret')
      .send({
        dateRange: {
          start: '2025-12-12T00:00:00.000Z',
          end: '2026-03-12T23:59:59.000Z',
        },
        expectedTotalMemories: 300,
        expectedTotalBatches: 3,
        batchSize: 100,
        options: {
          lang: 'zh-CN',
          taxonomyVersion: 'v1',
          llmEnabled: false,
          includeItems: true,
          includeSummary: true,
        },
      })
      .expect(201);
    const createBody = createResponse.body as CreateAnalysisJobResponse;

    expect(createBody.jobId).toBe('aj_test_1');

    await request(app.getHttpServer())
      .put('/v1/analysis-jobs/aj_test_1/batches/1')
      .set('x-mem9-api-key', 'mem9-secret')
      .send({
        memoryCount: 2,
        memories: [
          {
            id: 'm1',
            content: '我最近在做 AI agent 产品',
            createdAt: '2026-03-01T10:00:00.000Z',
            metadata: {},
          },
          {
            id: 'm2',
            content: '今天很开心',
            createdAt: '2026-03-02T10:00:00.000Z',
            metadata: {},
          },
        ],
      })
      .expect(200);

    const progressStore = new RedisProgressStore(redis as never, 86400);
    const tagCounts: Record<string, number> = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`tag-${index.toString().padStart(2, '0')}`, 1] as const),
    );
    const topicCounts: Record<string, number> = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`topic-${index.toString().padStart(2, '0')}`, 1] as const),
    );

    tagCounts.priority = 53;
    tagCounts.beta = 5;
    tagCounts.alpha = 5;
    topicCounts.roadmap = 9;
    topicCounts.project = 9;

    await progressStore.mergeBatch('aj_test_1', {
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
      tagCounts,
      topicCounts,
      summarySnapshot: ['identity:1', 'emotion:1'],
      batchResult: {
        batchIndex: 1,
        status: 'SUCCEEDED',
        memoryCount: 2,
        processedMemories: 2,
        topCategories: [
          { category: 'identity', count: 1, confidence: 0.5 },
          { category: 'emotion', count: 1, confidence: 0.5 },
        ],
        topTags: ['ai', '开心'],
      },
    });

    const snapshotResponse = await request(app.getHttpServer())
      .get('/v1/analysis-jobs/aj_test_1')
      .set('x-mem9-api-key', 'mem9-secret')
      .expect(200);
    const snapshotBody = snapshotResponse.body as AnalysisJobSnapshotResponse;

    expect(snapshotBody.progress.uploadedBatches).toBe(1);
    expect(snapshotBody.aggregate.categoryCounts.identity).toBe(1);
    expect(snapshotBody.topTagStats).toHaveLength(50);
    expect(snapshotBody.topTagStats[0]).toEqual({ value: 'priority', count: 53 });
    expect(snapshotBody.topTagStats[1]).toEqual({ value: 'alpha', count: 5 });
    expect(snapshotBody.topTagStats[2]).toEqual({ value: 'beta', count: 5 });
    expect(snapshotBody.topTagStats[49]).toEqual({ value: 'tag-46', count: 1 });
    expect(snapshotBody.topTags).toEqual(snapshotBody.topTagStats.map((stat) => stat.value));
    expect(snapshotBody.topTags).not.toContain('tag-47');
    expect(snapshotBody.topTopicStats).toHaveLength(50);
    expect(snapshotBody.topTopicStats[0]).toEqual({ value: 'project', count: 9 });
    expect(snapshotBody.topTopicStats[1]).toEqual({ value: 'roadmap', count: 9 });
    expect(snapshotBody.topTopics).toEqual(snapshotBody.topTopicStats.map((stat) => stat.value));
    expect(snapshotBody.topTopics).not.toContain('topic-49');
    expect(snapshotBody.aggregate.tagCounts['tag-47']).toBe(1);
    expect(snapshotBody.aggregate.tagCounts.priority).toBe(53);
    expect(snapshotBody.aggregate.topicCounts['topic-49']).toBe(1);
    expect(snapshotBody.aggregate.topicCounts.project).toBe(9);

    const updatesResponse = await request(app.getHttpServer())
      .get('/v1/analysis-jobs/aj_test_1/updates?cursor=0')
      .set('x-mem9-api-key', 'mem9-secret')
      .expect(200);
    const updatesBody = updatesResponse.body as AnalysisJobUpdatesResponse;

    expect(updatesBody.events).toHaveLength(1);
    expect(updatesBody.completedBatchResults).toHaveLength(1);
    expect(updatesBody.aggregate.tagCounts.priority).toBe(53);
  });
});
