import type { AppConfig } from '@mem9/config';
import { gunzipJson, gzipJson } from '@mem9/shared';

import { DeepAnalysisService } from './deep-analysis.service';

function createContext() {
  const apiKeyFingerprint = Buffer.alloc(32, 7);
  return {
    apiKeyFingerprint,
    apiKeyFingerprintHex: apiKeyFingerprint.toString('hex'),
    rawApiKey: 'space-key',
    requestId: 'req_1',
  };
}

function createConfig(overrides?: {
  app?: Partial<AppConfig["app"]>;
  database?: Partial<AppConfig["database"]>;
  redis?: Partial<AppConfig["redis"]>;
  aws?: Partial<AppConfig["aws"]>;
  analysis?: Partial<AppConfig["analysis"]>;
  goVerify?: Partial<AppConfig["goVerify"]>;
  sqs?: Partial<AppConfig["sqs"]>;
}): AppConfig {
  return {
    app: {
      env: 'production',
      port: 3000,
      workerHealthPort: 3001,
      logLevel: 'info',
      pepper: 'test-pepper-1234567890',
      ...overrides?.app,
    },
    database: {
      url: 'mysql://localhost/mem9',
      ...overrides?.database,
    },
    redis: {
      url: 'redis://localhost:6379',
      ...overrides?.redis,
    },
    aws: {
      region: 'us-east-1',
      forcePathStyle: false,
      s3BucketAnalysisPayloads: 'bucket',
      sqsAnalysisBatchQueueUrl: 'analysis-batch',
      sqsAnalysisBatchDlqUrl: 'analysis-batch-dlq',
      sqsAnalysisLlmQueueUrl: 'analysis-llm',
      sqsAnalysisLlmDlqUrl: 'analysis-llm-dlq',
      ...overrides?.aws,
    },
    analysis: {
      jobResultTtlSeconds: 86400,
      payloadRetentionDays: 7,
      defaultBatchSize: 100,
      maxBatchMemories: 100,
      maxBatchBytes: 1024 * 1024,
      maxMemoriesPerRequest: 100,
      pipelineVersion: 'v1',
      taxonomyVersion: 'v3',
      mem9SourceApiBaseUrl: 'http://127.0.0.1:8080/v1alpha2/mem9s',
      mem9SourcePageSize: 200,
      deepAnalysisDailyLimitBypassFingerprints: [],
      qwenApiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      qwenApiKey: undefined,
      qwenModel: 'qwen3.5-pro',
      ...overrides?.analysis,
    },
    goVerify: {
      mode: 'noop',
      baseUrl: 'http://127.0.0.1:8080',
      sharedSecret: 'local-secret',
      ...overrides?.goVerify,
    },
    sqs: {
      waitTimeSeconds: 10,
      visibilityTimeoutSeconds: 30,
      visibilityHeartbeatSeconds: 10,
      ...overrides?.sqs,
    },
  };
}

function createService(overrides?: {
  repository?: Record<string, unknown>;
  source?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  queue?: Record<string, unknown>;
  config?: {
    app?: Partial<AppConfig["app"]>;
    database?: Partial<AppConfig["database"]>;
    redis?: Partial<AppConfig["redis"]>;
    aws?: Partial<AppConfig["aws"]>;
    analysis?: Partial<AppConfig["analysis"]>;
    goVerify?: Partial<AppConfig["goVerify"]>;
    sqs?: Partial<AppConfig["sqs"]>;
  };
}) {
  const repository = {
    findDeepAnalysisReportByDay: jest.fn(async () => null),
    findDeepAnalysisReportsByDayPrefix: jest.fn(async () => []),
    createDeepAnalysisReport: jest.fn(async () => ({
      id: 'dar_1',
      status: 'QUEUED',
      stage: 'FETCH_SOURCE',
      progressPercent: 0,
      requestedAt: new Date('2026-03-28T00:00:00Z'),
      memoryCount: 1001,
      sourceSnapshotObjectKey: 'deep-analysis/reports/snapshot_1/source.json.gz',
    })),
    listOwnedDeepAnalysisReports: jest.fn(async () => ({
      reports: [],
      total: 0,
    })),
    getOwnedDeepAnalysisReport: jest.fn(async () => ({
      id: 'dar_1',
      status: 'COMPLETED',
      stage: 'COMPLETE',
      progressPercent: 100,
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
      memoryCount: 1001,
      requestedAt: new Date('2026-03-28T00:00:00Z'),
      startedAt: new Date('2026-03-28T00:01:00Z'),
      completedAt: new Date('2026-03-28T00:05:00Z'),
      errorCode: null,
      errorMessage: null,
      previewJson: null,
      reportObjectKey: null,
      sourceSnapshotObjectKey: 'deep-analysis/reports/snapshot_1/source.json.gz',
    })),
    ...overrides?.repository,
  };
  const source = {
    countMemories: jest.fn(async () => 1001),
    fetchAllMemories: jest.fn(async () => [
      {
        id: 'mem_1',
        content: 'Prefer React for dashboard work',
        createdAt: '2026-03-20T00:00:00Z',
        updatedAt: '2026-03-20T00:00:00Z',
        memoryType: 'insight',
        tags: ['dashboard'],
        metadata: null,
      },
    ]),
    ...overrides?.source,
  };
  const storage = {
    putCompressedJson: jest.fn(async () => undefined),
    getObjectBuffer: jest.fn(async () => Buffer.from('{}')),
    ...overrides?.storage,
  };
  const queue = {
    enqueueLlmMessage: jest.fn(async () => undefined),
    ...overrides?.queue,
  };
  const config = createConfig(overrides?.config);

  return {
    repository,
    source,
    storage,
    queue,
    config,
    service: new DeepAnalysisService(
      repository as never,
      source as never,
      storage as never,
      queue as never,
      config,
    ),
  };
}

describe('deep analysis service', () => {
  it('returns an already-running error when a report exists for the same day in production', async () => {
    const { service } = createService({
      repository: {
        findDeepAnalysisReportsByDayPrefix: jest.fn(async () => [{
          id: 'dar_existing',
          status: 'PREPARING',
        }]),
      },
    });

    await expect(
      service.createReport(createContext(), {
        lang: 'zh-CN',
        timezone: 'Asia/Shanghai',
      }),
    ).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_ALREADY_RUNNING',
      details: {
        reportId: 'dar_existing',
      },
    });
  });

  it('rejects requests with too few memories in production', async () => {
    const { service, source, storage, queue } = createService({
      source: {
        countMemories: jest.fn(async () => 999),
      },
    });

    await expect(
      service.createReport(createContext(), {
        lang: 'zh-CN',
        timezone: 'Asia/Shanghai',
      }),
    ).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_TOO_FEW_MEMORIES',
      details: {
        memoryCount: 999,
        minimum: 1000,
      },
    });

    expect(source.fetchAllMemories).not.toHaveBeenCalled();
    expect(storage.putCompressedJson).not.toHaveBeenCalled();
    expect(queue.enqueueLlmMessage).not.toHaveBeenCalled();
  });

  it('creates a report, uploads the source snapshot, and enqueues the LLM job in production', async () => {
    const memories = Array.from({ length: 1001 }, (_, index) => ({
      id: `mem_${index + 1}`,
      content: `Memory ${index + 1} about React and Alice`,
      createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      updatedAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      memoryType: 'insight',
      tags: ['project-a'],
      metadata: null,
    }));
    const { service, storage, queue, repository } = createService({
      source: {
        countMemories: jest.fn(async () => memories.length),
        fetchAllMemories: jest.fn(async () => memories),
      },
      repository: {
        createDeepAnalysisReport: jest.fn(async (input: {
          memoryCount: number;
          sourceSnapshotObjectKey: string;
          requestDayKey: string;
        }) => ({
          id: 'dar_created',
          status: 'QUEUED',
          stage: 'FETCH_SOURCE',
          progressPercent: 0,
          requestedAt: new Date('2026-03-28T00:00:00Z'),
          memoryCount: input.memoryCount,
          sourceSnapshotObjectKey: input.sourceSnapshotObjectKey,
          requestDayKey: input.requestDayKey,
        })),
      },
    });

    const response = await service.createReport(createContext(), {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response).toMatchObject({
      reportId: 'dar_created',
      status: 'QUEUED',
      stage: 'FETCH_SOURCE',
      progressPercent: 0,
      memoryCount: memories.length,
    });
    expect(storage.putCompressedJson).toHaveBeenCalledTimes(1);
    const [objectKey, payload] = storage.putCompressedJson.mock.calls[0] as unknown as [string, Buffer];
    expect(String(objectKey)).toMatch(/^deep-analysis\/reports\/snapshot_/);
    const snapshot = gunzipJson<{ memoryCount: number; memories: Array<{ id: string }> }>(payload as Buffer);
    expect(snapshot.memoryCount).toBe(memories.length);
    expect(snapshot.memories).toHaveLength(memories.length);
    expect(queue.enqueueLlmMessage).toHaveBeenCalledWith({
      messageType: 'deep_report',
      reportId: 'dar_created',
      traceId: 'req_1',
    });
    expect(repository.createDeepAnalysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestDayKey: '2026-03-28@Asia/Shanghai',
      }),
    );
  });

  it('bypasses daily-limit and count gates outside production', async () => {
    const memories = [
      {
        id: 'mem_local_1',
        content: 'Tiny sample memory',
        createdAt: '2026-03-20T00:00:00Z',
        updatedAt: '2026-03-20T00:00:00Z',
        memoryType: 'insight',
        tags: [],
        metadata: null,
      },
    ];
    const { service, repository, source } = createService({
      config: {
        app: {
          env: 'development',
        },
      },
      repository: {
        findDeepAnalysisReportsByDayPrefix: jest.fn(async () => [{
          id: 'dar_old',
          status: 'COMPLETED',
        }]),
        createDeepAnalysisReport: jest.fn(async (input: {
          requestDayKey: string;
          memoryCount: number;
        }) => ({
          id: 'dar_local',
          status: 'QUEUED',
          stage: 'FETCH_SOURCE',
          progressPercent: 0,
          requestedAt: new Date('2026-03-28T00:00:00Z'),
          memoryCount: input.memoryCount,
          requestDayKey: input.requestDayKey,
        })),
      },
      source: {
        countMemories: jest.fn(async () => 12),
        fetchAllMemories: jest.fn(async () => memories),
      },
    });

    const response = await service.createReport(createContext(), {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response.reportId).toBe('dar_local');
    expect(source.countMemories).not.toHaveBeenCalled();
    expect(repository.findDeepAnalysisReportsByDayPrefix).not.toHaveBeenCalled();
    expect(repository.createDeepAnalysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestDayKey: expect.stringMatching(/^2026-03-28@Asia\/Shanghai#dev-/),
        memoryCount: 1,
      }),
    );
  });

  it('allows a production rerun for bypass fingerprints while keeping the same day prefix', async () => {
    const context = createContext();
    const { service, repository } = createService({
      config: {
        analysis: {
          deepAnalysisDailyLimitBypassFingerprints: [context.apiKeyFingerprintHex],
        },
      },
      repository: {
        findDeepAnalysisReportsByDayPrefix: jest.fn(async () => [{
          id: 'dar_old',
          status: 'COMPLETED',
        }]),
        createDeepAnalysisReport: jest.fn(async (input: {
          requestDayKey: string;
          memoryCount: number;
        }) => ({
          id: 'dar_rerun',
          status: 'QUEUED',
          stage: 'FETCH_SOURCE',
          progressPercent: 0,
          requestedAt: new Date('2026-03-28T00:00:00Z'),
          memoryCount: input.memoryCount,
          requestDayKey: input.requestDayKey,
        })),
      },
      source: {
        countMemories: jest.fn(async () => 1001),
        fetchAllMemories: jest.fn(async () => Array.from({ length: 1001 }, (_, index) => ({
          id: `mem_${index + 1}`,
          content: `Memory ${index + 1}`,
          createdAt: '2026-03-20T00:00:00Z',
          updatedAt: '2026-03-20T00:00:00Z',
          memoryType: 'insight',
          tags: [],
          metadata: null,
        }))),
      },
    });

    const response = await service.createReport(context, {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response.reportId).toBe('dar_rerun');
    expect(repository.createDeepAnalysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestDayKey: expect.stringMatching(/^2026-03-28@Asia\/Shanghai#rerun-/),
      }),
    );
  });

  it('lists reports, loads report details, and exports duplicate cleanup csv', async () => {
    const reportDocument = {
      overview: {
        memoryCount: 1001,
        deduplicatedMemoryCount: 900,
        generatedAt: '2026-03-28T00:05:00Z',
        lang: 'zh-CN',
        timeSpan: {
          start: '2026-03-01T00:00:00Z',
          end: '2026-03-28T00:00:00Z',
        },
      },
      persona: {
        summary: 'The user prefers structured engineering workflows.',
        workingStyle: ['Works iteratively with strong review loops.'],
        goals: [],
        preferences: [],
        constraints: [],
        decisionSignals: [],
        notableRoutines: [],
        contradictionsOrTensions: [],
        evidenceHighlights: [],
      },
      themeLandscape: {
        highlights: [],
      },
      entities: {
        people: [],
        teams: [],
        projects: [],
        tools: [],
        places: [],
      },
      relationships: [],
      quality: {
        duplicateRatio: 0.1,
        duplicateMemoryCount: 2,
        noisyMemoryCount: 5,
        duplicateClusters: [
          {
            canonicalMemoryId: 'mem_1',
            duplicateMemoryIds: ['mem_2', 'mem_3'],
          },
        ],
        lowQualityExamples: [],
        coverageGaps: [],
      },
      recommendations: [],
      productSignals: {
        candidateNodes: [],
        candidateEdges: [],
        searchSeeds: [],
      },
    };
    const sourceSnapshot = gzipJson({
      fetchedAt: '2026-03-28T00:00:00Z',
      memoryCount: 3,
      memories: [
        {
          id: 'mem_1',
          content: 'Canonical memory about React dashboards',
          createdAt: '2026-03-01T00:00:00Z',
        },
        {
          id: 'mem_2',
          content: 'Canonical memory about React dashboards',
          createdAt: '2026-03-02T00:00:00Z',
        },
        {
          id: 'mem_3',
          content: 'Canonical memory about React dashboards',
          createdAt: '2026-03-03T00:00:00Z',
        },
      ],
    });
    const { service } = createService({
      repository: {
        listOwnedDeepAnalysisReports: jest.fn(async () => ({
          reports: [
            {
              id: 'dar_1',
              status: 'COMPLETED',
              stage: 'COMPLETE',
              progressPercent: 100,
              lang: 'zh-CN',
              timezone: 'Asia/Shanghai',
              memoryCount: 1001,
              requestedAt: new Date('2026-03-28T00:00:00Z'),
              startedAt: new Date('2026-03-28T00:01:00Z'),
              completedAt: new Date('2026-03-28T00:05:00Z'),
              errorCode: null,
              errorMessage: null,
              previewJson: {
                generatedAt: '2026-03-28T00:05:00Z',
                summary: 'Engineering-heavy corpus.',
                topThemes: ['engineering'],
                keyRecommendations: ['Deduplicate repeated notes'],
              },
            },
          ],
          total: 1,
        })),
        getOwnedDeepAnalysisReport: jest.fn(async () => ({
          id: 'dar_1',
          status: 'COMPLETED',
          stage: 'COMPLETE',
          progressPercent: 100,
          lang: 'zh-CN',
          timezone: 'Asia/Shanghai',
          memoryCount: 1001,
          requestedAt: new Date('2026-03-28T00:00:00Z'),
          startedAt: new Date('2026-03-28T00:01:00Z'),
          completedAt: new Date('2026-03-28T00:05:00Z'),
          errorCode: null,
          errorMessage: null,
          previewJson: {
            generatedAt: '2026-03-28T00:05:00Z',
            summary: 'Engineering-heavy corpus.',
            topThemes: ['engineering'],
            keyRecommendations: ['Deduplicate repeated notes'],
          },
          reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
          sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
        })),
      },
      storage: {
        getObjectBuffer: jest.fn(async (key: string) => {
          if (key.endsWith('source.json.gz')) {
            return sourceSnapshot;
          }
          return Buffer.from(JSON.stringify(reportDocument));
        }),
      },
    });

    const list = await service.listReports(createContext(), { limit: 20, offset: 0 });
    expect(list.total).toBe(1);
    expect(list.reports[0]).toMatchObject({
      id: 'dar_1',
      status: 'COMPLETED',
      preview: {
        summary: 'Engineering-heavy corpus.',
      },
    });

    const detail = await service.getReport(createContext(), 'dar_1');
    expect(detail.report).toMatchObject({
      overview: {
        deduplicatedMemoryCount: 900,
      },
      persona: {
        summary: 'The user prefers structured engineering workflows.',
      },
    });

    const exported = await service.downloadDuplicateCleanupCsv(createContext(), 'dar_1');
    expect(exported.filename).toBe('deep-analysis-dar_1-duplicate-cleanup.csv');
    expect(exported.content).toContain('duplicateMemoryId');
    expect(exported.content).toContain('mem_2');
    expect(exported.content).toContain('mem_3');
    expect(exported.content).not.toContain('"mem_1"');
  });
});
