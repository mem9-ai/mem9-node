import type { AppConfig } from '@mem9/config';

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
      deletedCount: 1,
      deletedMemoryIds: ['mem_2'],
      failedMemoryIds: [],
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

describe('deep analysis service', () => {
  it('returns an already-running error when a report exists for the same day in production', async () => {
    const { service, sourcePreparation } = createService({
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

    expect(sourcePreparation.schedule).not.toHaveBeenCalled();
  });

  it('rejects requests with too few memories in production', async () => {
    const { service, sourcePreparation } = createService({
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

    expect(sourcePreparation.schedule).not.toHaveBeenCalled();
  });

  it('creates a report and delegates source preparation', async () => {
    const { service, repository, sourcePreparation } = createService({
      repository: {
        createDeepAnalysisReport: jest.fn(async (input: {
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

  it('bypasses daily-limit and count gates outside production', async () => {
    const { service, repository } = createService({
      config: {
        app: {
          env: 'development',
        },
      },
      repository: {
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
      },
    });

    const response = await service.createReport(createContext(), {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response.reportId).toBe('dar_local');
    expect(repository.findDeepAnalysisReportsByDayPrefix).not.toHaveBeenCalled();
    expect(repository.createDeepAnalysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestDayKey: expect.stringMatching(/^2026-03-28@Asia\/Shanghai#dev-/),
        memoryCount: 12,
      }),
    );
  });

  it('allows production reruns for bypass fingerprints while keeping the same day prefix', async () => {
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
        getObjectBuffer: jest.fn(async () => Buffer.from(JSON.stringify(document))),
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
    expect(repository.getOwnedDeepAnalysisReport).toHaveBeenCalledWith('dar_1', context.apiKeyFingerprint);
    expect(detailResponse.report).toEqual(document);
  });

  it('delegates duplicate CSV download, duplicate deletion, and terminal report deletion', async () => {
    const { service, duplicateOps } = createService();
    const context = createContext();

    await service.downloadDuplicateCleanupCsv(context, 'dar_1');
    await service.deleteDuplicateMemories(context, 'dar_1');
    await service.deleteReport(context, 'dar_1');

    expect(duplicateOps.downloadDuplicateCleanupCsv).toHaveBeenCalledWith(context, 'dar_1');
    expect(duplicateOps.deleteDuplicateMemories).toHaveBeenCalledWith(context, 'dar_1');
    expect(duplicateOps.deleteReport).toHaveBeenCalledWith(context, 'dar_1');
  });
});
