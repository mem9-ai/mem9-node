import type { AppConfig } from '@mem9/config';

import { Mem9SourceService } from './mem9-source.service';

const TEST_QWEN_MODEL = 'test-qwen-model';

function createConfig(overrides?: Partial<AppConfig['analysis']>): AppConfig {
  return {
    app: {
      env: 'test',
      port: 3000,
      workerHealthPort: 3001,
      logLevel: 'info',
      pepper: 'test-pepper-1234567890',
    },
    sentry: {
      dsn: undefined,
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
      qwenModel: TEST_QWEN_MODEL,
      qwenRequestTimeoutMs: 120000,
      deepAnalysisChunkConcurrency: 5,
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
    text: jest.fn(async () => (payload === undefined ? '' : JSON.stringify(payload))),
  } as unknown as Response;
}

describe('mem9 source service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries timeout-like failures and eventually returns the memory count', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('timeout'), { name: 'AbortError' }),
      )
      .mockResolvedValueOnce(
        createResponse(200, {
          memories: [],
          total: 123,
          limit: 1,
          offset: 0,
        }),
      );
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig());

    const result = await service.countMemories('space-key');

    expect(result).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable 4xx responses', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createResponse(404, {
        error: 'not found',
      }),
    );
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
    const service = new Mem9SourceService(
      createConfig({
        mem9SourceDeleteConcurrency: 2,
      }),
    );

    const result = await service.deleteMemories('space-key', [
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);

    expect(result.deletedMemoryIds).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('filters incorrectly marked session memories from analysis source fetches', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createResponse(200, {
        memories: [
          {
            id: 'turn-correct',
            content: 'correct content',
            created_at: '2026-06-27T00:00:00Z',
            memory_type: 'session',
            metadata: { correctness: 'correct' },
          },
          {
            id: 'turn-incorrect',
            content: 'incorrect content',
            created_at: '2026-06-27T00:01:00Z',
            memory_type: 'session',
            metadata: { correctness: 'incorrect' },
          },
          {
            id: 'turn-unmarked',
            content: 'unmarked content',
            created_at: '2026-06-27T00:02:00Z',
            memory_type: 'session',
            metadata: {},
          },
        ],
        total: 3,
        limit: 200,
        offset: 0,
      }),
    );
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig());

    const memories = await service.fetchSessionMemories('space-key', {
      createdAfter: '2026-06-27T00:00:00Z',
      createdBefore: '2026-06-27T23:59:59Z',
    });

    expect(memories.map((memory) => memory.id)).toEqual([
      'turn-correct',
      'turn-unmarked',
    ]);
  });

  it('does not filter incorrectly marked non-session memories from all-memory fetches', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createResponse(200, {
        memories: [
          {
            id: 'insight-incorrect',
            content: 'insight content',
            created_at: '2026-06-27T00:00:00Z',
            memory_type: 'insight',
            metadata: { correctness: 'incorrect' },
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
      }),
    );
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig());

    const memories = await service.fetchAllMemories('space-key');

    expect(memories.map((memory) => memory.id)).toEqual(['insight-incorrect']);
  });

  it('normalizes session message edit responses', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createResponse(200, {
        edit_id: 'turn-1',
        version: 2,
        edit: {
          id: 'turn-1',
          original_content: 'original',
          edited_content: 'corrected',
          edited_tags: ['tag-a'],
          correctness: 'correct',
          version: 2,
          created_at: '2026-06-27T00:00:00Z',
          updated_at: '2026-06-27T00:01:00Z',
        },
        session: {
          id: 'turn-1',
          content: 'corrected',
          created_at: '2026-06-27T00:00:00Z',
          updated_at: '2026-06-27T00:01:00Z',
          memory_type: 'session',
          tags: ['tag-a'],
          metadata: { edited: true },
        },
      }),
    );
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig());

    const result = await service.editSessionMessage('space-key', 'turn-1', {
      content: 'corrected',
      tags: ['tag-a'],
    });

    expect(result).toEqual({
      id: 'turn-1',
      editId: 'turn-1',
      version: 2,
      correctness: 'correct',
      originalContent: 'original',
      editedContent: 'corrected',
      tags: ['tag-a'],
      session: {
        id: 'turn-1',
        content: 'corrected',
        createdAt: '2026-06-27T00:00:00Z',
        updatedAt: '2026-06-27T00:01:00Z',
        memoryType: 'session',
        tags: ['tag-a'],
        metadata: { edited: true },
      },
    });
  });

  it('maps missing session edit overlays to a stable not-found code', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createResponse(404, {
        error: 'not found',
      }),
    );
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig());

    await expect(service.getSessionMessageEdit('space-key', 'turn-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'SESSION_MESSAGE_EDIT_NOT_FOUND',
      details: {
        upstreamStatus: 404,
        upstreamError: 'not found',
      },
    });
  });

  it('maps invalid marks to a stable validation code', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createResponse(400, {
        error: "correctness: must be 'correct' or 'incorrect'",
      }),
    );
    global.fetch = fetchMock as typeof fetch;
    const service = new Mem9SourceService(createConfig());

    await expect(service.markSessionMessage('space-key', 'turn-1', 'correct')).rejects.toMatchObject({
      statusCode: 400,
      code: 'SESSION_MESSAGE_MARK_INVALID',
      details: {
        upstreamStatus: 400,
        upstreamError: "correctness: must be 'correct' or 'incorrect'",
      },
    });
  });
});
