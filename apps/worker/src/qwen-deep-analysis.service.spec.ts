import type { AppConfig } from '@mem9/config';

import { QwenDeepAnalysisService } from './qwen-deep-analysis.service';

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
      qwenApiKey: 'test-qwen-key',
      qwenModel: 'qwen3.5-pro',
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

describe('qwen deep analysis service', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('parses usage on a successful JSON response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        model: 'qwen3.5-pro',
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
        },
        choices: [{
          message: {
            content: '{"summary":"ok"}',
          },
        }],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const service = new QwenDeepAnalysisService(createConfig());
    const result = await service.createJson<{ summary: string }>(
      'chunk_analysis',
      'system prompt',
      'user prompt',
    );

    expect(result.parsed).toEqual({ summary: 'ok' });
    expect(result.requestMeta).toMatchObject({
      stage: 'chunk_analysis',
      success: true,
      requested: true,
      httpStatus: 200,
      parseSucceeded: true,
    });
    expect(result.usage).toEqual({
      model: 'qwen3.5-pro',
      promptTokens: 123,
      completionTokens: 45,
      totalTokens: 168,
      usageMissing: false,
    });
  });

  it('returns usage and failure metadata when JSON parsing fails', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        model: 'qwen3.5-pro',
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          total_tokens: 30,
        },
        choices: [{
          message: {
            content: '{bad json}',
          },
        }],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const service = new QwenDeepAnalysisService(createConfig());
    const result = await service.createJson<{ summary: string }>(
      'global_synthesis',
      'system prompt',
      'user prompt',
    );

    expect(result.parsed).toBeNull();
    expect(result.requestMeta).toMatchObject({
      stage: 'global_synthesis',
      success: false,
      requested: true,
      httpStatus: 200,
      parseSucceeded: false,
      errorCode: 'QWEN_JSON_PARSE_FAILED',
    });
    expect(result.usage).toEqual({
      model: 'qwen3.5-pro',
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      usageMissing: false,
    });
  });

  it('returns failure metadata and counts usage as missing on HTTP errors', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          code: 'quota_exceeded',
          message: 'quota exceeded',
        },
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const service = new QwenDeepAnalysisService(createConfig());
    const result = await service.createJson<{ summary: string }>(
      'chunk_analysis',
      'system prompt',
      'user prompt',
    );

    expect(result.parsed).toBeNull();
    expect(result.requestMeta).toMatchObject({
      stage: 'chunk_analysis',
      success: false,
      requested: true,
      httpStatus: 429,
      parseSucceeded: false,
      errorCode: 'quota_exceeded',
      errorMessage: 'quota exceeded',
    });
    expect(result.usage).toEqual({
      model: 'qwen3.5-pro',
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageMissing: true,
    });
  });

  it('times out stalled requests instead of waiting forever', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    }) as typeof fetch);

    const service = new QwenDeepAnalysisService(createConfig({
      analysis: {
        qwenRequestTimeoutMs: 50,
      },
    }));
    const resultPromise = service.createJson<{ summary: string }>(
      'chunk_analysis',
      'system prompt',
      'user prompt',
    );

    await jest.advanceTimersByTimeAsync(60);
    const result = await resultPromise;

    expect(result.parsed).toBeNull();
    expect(result.requestMeta).toMatchObject({
      stage: 'chunk_analysis',
      success: false,
      requested: true,
      httpStatus: null,
      parseSucceeded: false,
      errorCode: 'QWEN_REQUEST_TIMEOUT',
      errorMessage: 'Qwen request timed out after 50ms',
    });
    expect(result.usage).toEqual({
      model: 'qwen3.5-pro',
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageMissing: true,
    });
  });
});
