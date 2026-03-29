import type { AppConfig } from '@mem9/config';

import { DeepAnalysisService } from './deep-analysis.service';

const TEST_QWEN_MODEL = 'test-qwen-model';

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
  app?: Partial<AppConfig['app']>;
  database?: Partial<AppConfig['database']>;
  redis?: Partial<AppConfig['redis']>;
  aws?: Partial<AppConfig['aws']>;
  analysis?: Partial<AppConfig['analysis']>;
  goVerify?: Partial<AppConfig['goVerify']>;
  sqs?: Partial<AppConfig['sqs']>;
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
    sentry: {
      dsn: undefined,
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
      mem9SourceRequestTimeoutMs: 10000,
      mem9SourceFetchRetries: 2,
      mem9SourceFetchRetryBaseMs: 250,
      mem9SourceDeleteConcurrency: 4,
      deepAnalysisDailyLimitBypassFingerprints: [],
      qwenApiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      qwenApiKey: undefined,
      qwenModel: TEST_QWEN_MODEL,
      qwenRequestTimeoutMs: 120000,
      deepAnalysisChunkConcurrency: 5,
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
  sourcePreparation?: Record<string, unknown>;
  duplicateOps?: Record<string, unknown>;
  config?: {
    app?: Partial<AppConfig['app']>;
    database?: Partial<AppConfig['database']>;
    redis?: Partial<AppConfig['redis']>;
    aws?: Partial<AppConfig['aws']>;
    analysis?: Partial<AppConfig['analysis']>;
    goVerify?: Partial<AppConfig['goVerify']>;
    sqs?: Partial<AppConfig['sqs']>;
  };
}) {
  const repository = {
    findDeepAnalysisReportsByDayPrefix: jest.fn(async () => []),
    createDeepAnalysisReport: jest.fn(async () => ({
      id: 'dar_1',
      status: 'QUEUED',
      stage: 'FETCH_SOURCE',
      progressPercent: 0,
      requestedAt: new Date('2026-03-28T00:00:00Z'),
      memoryCount: 1001,
      sourceSnapshotObjectKey:
        'deep-analysis/reports/snapshot_1/source.json.gz',
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
      sourceSnapshotObjectKey:
        'deep-analysis/reports/snapshot_1/source.json.gz',
    })),
    ...overrides?.repository,
  };
  const source = {
    countMemories: jest.fn(async () => 1001),
    ...overrides?.source,
  };
  const storage = {
    getObjectBuffer: jest.fn(async () => Buffer.from('{}')),
    ...overrides?.storage,
  };
  const sourcePreparation = {
    schedule: jest.fn(),
    ...overrides?.sourcePreparation,
  };
  const duplicateOps = {
    deleteDuplicateMemories: jest.fn(async () => ({
      reportId: 'dar_1',
      duplicateCleanup: {
        status: 'QUEUED',
        requestedAt: '2026-03-29T00:00:00Z',
        startedAt: null,
        completedAt: null,
        totalCount: 2,
        deletedCount: 0,
        failedCount: 0,
        deletedMemoryIds: [],
        failedMemoryIds: [],
        errorMessage: null,
      },
    })),
    deleteReport: jest.fn(async () => ({
      reportId: 'dar_1',
    })),
    downloadDuplicateCleanupCsv: jest.fn(async () => ({
      filename: 'duplicates.csv',
      content: 'duplicateMemoryId\nmem_2\n',
    })),
    ...overrides?.duplicateOps,
  };
  const config = createConfig(overrides?.config);

  return {
    repository,
    source,
    storage,
    sourcePreparation,
    duplicateOps,
    service: new DeepAnalysisService(
      repository as never,
      source as never,
      storage as never,
      sourcePreparation as never,
      duplicateOps as never,
      config,
    ),
  };
}

function getCreateReportCall<T extends { requestDayKey: string }>(mockFn: unknown): T {
  const createDeepAnalysisReport = mockFn as jest.MockedFunction<
    (input: T) => Promise<unknown>
  >;
  const [input] = createDeepAnalysisReport.mock.lastCall ?? [];

  if (!input) {
    throw new Error('Expected createDeepAnalysisReport to be called');
  }

  return input;
}

describe('deep analysis service', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns an already-running error when a report exists for the same day in production', async () => {
    const { service, sourcePreparation } = createService({
      repository: {
        findDeepAnalysisReportsByDayPrefix: jest.fn(async () => [
          {
            id: 'dar_existing',
            status: 'PREPARING',
          },
        ]),
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

    expect(sourcePreparation.schedule).not.toHaveBeenCalled();
  });

  it('allows production runs with fewer than 1000 memories', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-28T00:00:00Z'));

    const { service, repository } = createService({
      repository: {
        createDeepAnalysisReport: jest.fn(
          async (input: { requestDayKey: string; memoryCount: number }) => ({
            id: 'dar_small',
            status: 'QUEUED',
            stage: 'FETCH_SOURCE',
            progressPercent: 0,
            requestedAt: new Date('2026-03-28T00:00:00Z'),
            memoryCount: input.memoryCount,
            requestDayKey: input.requestDayKey,
          }),
        ),
      },
      source: {
        countMemories: jest.fn(async () => 0),
      },
    });

    const response = await service.createReport(createContext(), {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response).toMatchObject({
      reportId: 'dar_small',
      memoryCount: 0,
    });
    expect(repository.createDeepAnalysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestDayKey: '2026-03-28@Asia/Shanghai',
        memoryCount: 0,
      }),
    );
  });

  it('creates a report and delegates source preparation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-28T00:00:00Z'));

    const { service, repository, sourcePreparation } = createService({
      repository: {
        createDeepAnalysisReport: jest.fn(
          async (input: {
            requestDayKey: string;
            memoryCount: number;
            sourceSnapshotObjectKey: string;
          }) => ({
            id: 'dar_created',
            status: 'QUEUED',
            stage: 'FETCH_SOURCE',
            progressPercent: 0,
            requestedAt: new Date('2026-03-28T00:00:00Z'),
            memoryCount: input.memoryCount,
            sourceSnapshotObjectKey: input.sourceSnapshotObjectKey,
            requestDayKey: input.requestDayKey,
          }),
        ),
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
      memoryCount: 1001,
    });
    expect(repository.createDeepAnalysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestDayKey: '2026-03-28@Asia/Shanghai',
      }),
    );
    expect(sourcePreparation.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: 'dar_created',
        rawApiKey: 'space-key',
        traceId: 'req_1',
      }),
    );
  });

  it('uses the third daily slot for the third production run', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-28T00:00:00Z'));

    const { service, repository } = createService({
      repository: {
        findDeepAnalysisReportsByDayPrefix: jest.fn(async () => [
          {
            id: 'dar_2',
            status: 'COMPLETED',
          },
          {
            id: 'dar_1',
            status: 'FAILED',
          },
        ]),
        createDeepAnalysisReport: jest.fn(
          async (input: { requestDayKey: string; memoryCount: number }) => ({
            id: 'dar_3',
            status: 'QUEUED',
            stage: 'FETCH_SOURCE',
            progressPercent: 0,
            requestedAt: new Date('2026-03-28T00:00:00Z'),
            memoryCount: input.memoryCount,
            requestDayKey: input.requestDayKey,
          }),
        ),
      },
    });

    const response = await service.createReport(createContext(), {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response.reportId).toBe('dar_3');
    expect(repository.createDeepAnalysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestDayKey: '2026-03-28@Asia/Shanghai#3',
      }),
    );
  });

  it('rejects the fourth production run on the same day', async () => {
    const { service, sourcePreparation } = createService({
      repository: {
        findDeepAnalysisReportsByDayPrefix: jest.fn(async () => [
          {
            id: 'dar_3',
            status: 'COMPLETED',
          },
          {
            id: 'dar_2',
            status: 'FAILED',
          },
          {
            id: 'dar_1',
            status: 'COMPLETED',
          },
        ]),
      },
    });

    await expect(
      service.createReport(createContext(), {
        lang: 'zh-CN',
        timezone: 'Asia/Shanghai',
      }),
    ).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_DAILY_LIMIT',
      details: {
        reportId: 'dar_3',
        maximumPerDay: 3,
      },
    });

    expect(sourcePreparation.schedule).not.toHaveBeenCalled();
  });

  it('bypasses daily-limit and count gates outside production', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-28T00:00:00Z'));

    const { service, repository } = createService({
      config: {
        app: {
          env: 'development',
        },
      },
      repository: {
        createDeepAnalysisReport: jest.fn(
          async (input: { requestDayKey: string; memoryCount: number }) => ({
            id: 'dar_local',
            status: 'QUEUED',
            stage: 'FETCH_SOURCE',
            progressPercent: 0,
            requestedAt: new Date('2026-03-28T00:00:00Z'),
            memoryCount: input.memoryCount,
            requestDayKey: input.requestDayKey,
          }),
        ),
      },
      source: {
        countMemories: jest.fn(async () => 12),
      },
    });

    const response = await service.createReport(createContext(), {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response.reportId).toBe('dar_local');
    expect(
      repository.findDeepAnalysisReportsByDayPrefix,
    ).not.toHaveBeenCalled();
    const devCreateInput = getCreateReportCall<{
      requestDayKey: string;
      memoryCount: number;
    }>(repository.createDeepAnalysisReport);
    expect(devCreateInput.requestDayKey).toMatch(
      /^2026-03-28@Asia\/Shanghai#dev-/,
    );
    expect(devCreateInput.memoryCount).toBe(12);
  });

  it('allows production reruns for bypass fingerprints while keeping the same day prefix', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-28T00:00:00Z'));

    const context = createContext();
    const { service, repository } = createService({
      config: {
        analysis: {
          deepAnalysisDailyLimitBypassFingerprints: [
            context.apiKeyFingerprintHex,
          ],
        },
      },
      repository: {
        findDeepAnalysisReportsByDayPrefix: jest.fn(async () => [
          {
            id: 'dar_old',
            status: 'COMPLETED',
          },
        ]),
        createDeepAnalysisReport: jest.fn(
          async (input: { requestDayKey: string; memoryCount: number }) => ({
            id: 'dar_rerun',
            status: 'QUEUED',
            stage: 'FETCH_SOURCE',
            progressPercent: 0,
            requestedAt: new Date('2026-03-28T00:00:00Z'),
            memoryCount: input.memoryCount,
            requestDayKey: input.requestDayKey,
          }),
        ),
      },
    });

    const response = await service.createReport(context, {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response.reportId).toBe('dar_rerun');
    const rerunCreateInput = getCreateReportCall<{
      requestDayKey: string;
    }>(repository.createDeepAnalysisReport);
    expect(rerunCreateInput.requestDayKey).toMatch(
      /^2026-03-28@Asia\/Shanghai#rerun-/,
    );
  });

  it('lists reports and loads report details from storage', async () => {
    const document = {
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
    };
    const { service, repository } = createService({
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
          previewJson: null,
          reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
          sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
        })),
      },
      storage: {
        getObjectBuffer: jest.fn(async () =>
          Buffer.from(JSON.stringify(document)),
        ),
      },
    });

    const context = createContext();
    const listResponse = await service.listReports(context, {
      limit: 20,
      offset: 0,
    });
    const detailResponse = await service.getReport(context, 'dar_1');

    expect(listResponse.total).toBe(1);
    expect(listResponse.reports[0]?.id).toBe('dar_1');
    expect(repository.getOwnedDeepAnalysisReport).toHaveBeenCalledWith(
      'dar_1',
      context.apiKeyFingerprint,
    );
    expect(detailResponse.report).toEqual(document);
  });

  it('delegates duplicate CSV download, duplicate deletion, and terminal report deletion', async () => {
    const { service, duplicateOps } = createService();
    const context = createContext();

    await service.downloadDuplicateCleanupCsv(context, 'dar_1');
    await service.deleteDuplicateMemories(context, 'dar_1');
    await service.deleteReport(context, 'dar_1');

    expect(duplicateOps.downloadDuplicateCleanupCsv).toHaveBeenCalledWith(
      context,
      'dar_1',
    );
    expect(duplicateOps.deleteDuplicateMemories).toHaveBeenCalledWith(
      context,
      'dar_1',
    );
    expect(duplicateOps.deleteReport).toHaveBeenCalledWith(context, 'dar_1');
  });
});
