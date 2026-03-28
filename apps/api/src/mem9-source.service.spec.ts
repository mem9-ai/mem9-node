import type { AppConfig } from '@mem9/config';

import { Mem9SourceService } from './mem9-source.service';

function createConfig(overrides?: Partial<AppConfig['analysis']>): AppConfig {
  return {
    app: {
      env: 'test',
      port: 3000,
      workerHealthPort: 3001,
      logLevel: 'info',
      pepper: 'test-pepper-1234567890',
    },
    database: {
      url: 'mysql://localhost/mem9',
    },
    redis: {
      url: 'redis://localhost:6379',
    },
    aws: {
      region: 'us-east-1',
      forcePathStyle: false,
      s3BucketAnalysisPayloads: 'bucket',
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
      maxBatchBytes: 1024 * 1024,
      maxMemoriesPerRequest: 100,
      pipelineVersion: 'v1',
      taxonomyVersion: 'v3',
      mem9SourceApiBaseUrl: 'http://127.0.0.1:8080/v1alpha2/mem9s',
      mem9SourcePageSize: 200,
      mem9SourceRequestTimeoutMs: 25,
      mem9SourceFetchRetries: 2,
      mem9SourceFetchRetryBaseMs: 1,
      mem9SourceDeleteConcurrency: 2,
      deepAnalysisDailyLimitBypassFingerprints: [],
      qwenApiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      qwenApiKey: undefined,
      qwenModel: 'qwen3.5-pro',
      qwenRequestTimeoutMs: 120000,
      ...overrides,
    },
    goVerify: {
      mode: 'noop',
      baseUrl: 'http://127.0.0.1:8080',
      sharedSecret: 'local-secret',
    },
    sqs: {
      waitTimeSeconds: 10,
      visibilityTimeoutSeconds: 30,
      visibilityHeartbeatSeconds: 10,
    },
  };
}

function createResponse(status: number, payload?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => payload),
  } as unknown as Response;
}

describe('mem9 source service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries timeout-like failures and eventually returns the memory count', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'AbortError' }))
      .mockResolvedValueOnce(createResponse(200, {
        memories: [],
        total: 123,
        limit: 1,
        offset: 0,
      }));
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig());

    const result = await service.countMemories('space-key');

    expect(result).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable 4xx responses', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(createResponse(404, {
        error: 'not found',
      }));
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig());

    await expect(service.countMemories('space-key')).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED',
      details: {
        status: 404,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('limits delete concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = jest.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return createResponse(204);
    });
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig({
      mem9SourceDeleteConcurrency: 2,
    }));

    const result = await service.deleteMemories('space-key', ['m1', 'm2', 'm3', 'm4', 'm5']);

    expect(result.deletedMemoryIds).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
