import type { AppConfig } from '@mem9/config';

import { SqsConsumerService } from './sqs-consumer.service';

const TEST_QWEN_MODEL = 'test-qwen-model';

function createConfig(overrides?: Partial<AppConfig['sqs']>): AppConfig {
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
    },
    goVerify: {
      mode: 'noop',
      baseUrl: 'http://127.0.0.1:8080',
      sharedSecret: 'local-secret',
    },
    sqs: {
      waitTimeSeconds: 10,
      visibilityTimeoutSeconds: 30,
      visibilityHeartbeatSeconds: 7,
      ...overrides,
    },
  };
}

describe('sqs consumer service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips malformed batch messages and continues processing later messages', async () => {
    const queue = {
      receiveBatchMessages: jest
        .fn()
        .mockResolvedValueOnce([
          {
            Body: '{bad json',
            ReceiptHandle: 'rh_bad',
            Attributes: { ApproximateReceiveCount: '1' },
          },
          {
            Body: JSON.stringify({
              jobId: 'aj_1',
              batchIndex: 1,
              payloadObjectKey: 'analysis-jobs/aj_1/batches/1.json.gz',
              payloadHash: 'hash',
              memoryCount: 1,
              pipelineVersion: 'v1',
              taxonomyVersion: 'v1',
              llmEnabled: false,
              traceId: 'trace_1',
            }),
            ReceiptHandle: 'rh_good',
            Attributes: { ApproximateReceiveCount: '2' },
          },
        ])
        .mockImplementationOnce(async () => {
          consumer['running'] = false;
          return [];
        }),
      extendVisibility: jest.fn(async () => undefined),
      deleteMessage: jest.fn(async () => undefined),
      receiveLlmMessages: jest.fn(async () => []),
      extendLlmVisibility: jest.fn(async () => undefined),
      deleteLlmMessage: jest.fn(async () => undefined),
    };
    const batchProcessor = {
      process: jest.fn(async () => undefined),
    };
    const consumer = new SqsConsumerService(
      queue as never,
      batchProcessor as never,
      {
        process: jest.fn(),
      } as never,
      createConfig(),
    );
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    consumer['running'] = true;
    await consumer['consumeBatchLoop']();

    expect(batchProcessor.process).toHaveBeenCalledTimes(1);
    expect(queue.deleteMessage).toHaveBeenCalledWith('rh_good');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 7000);
  });

  it('keeps consuming after one processor failure', async () => {
    const queue = {
      receiveBatchMessages: jest
        .fn()
        .mockResolvedValueOnce([
          {
            Body: JSON.stringify({
              jobId: 'aj_1',
              batchIndex: 1,
              payloadObjectKey: 'analysis-jobs/aj_1/batches/1.json.gz',
              payloadHash: 'hash',
              memoryCount: 1,
              pipelineVersion: 'v1',
              taxonomyVersion: 'v1',
              llmEnabled: false,
              traceId: 'trace_1',
            }),
            ReceiptHandle: 'rh_1',
            Attributes: { ApproximateReceiveCount: '1' },
          },
          {
            Body: JSON.stringify({
              jobId: 'aj_2',
              batchIndex: 1,
              payloadObjectKey: 'analysis-jobs/aj_2/batches/1.json.gz',
              payloadHash: 'hash',
              memoryCount: 1,
              pipelineVersion: 'v1',
              taxonomyVersion: 'v1',
              llmEnabled: false,
              traceId: 'trace_2',
            }),
            ReceiptHandle: 'rh_2',
            Attributes: { ApproximateReceiveCount: '1' },
          },
        ])
        .mockImplementationOnce(async () => {
          consumer['running'] = false;
          return [];
        }),
      extendVisibility: jest.fn(async () => undefined),
      deleteMessage: jest.fn(async () => undefined),
      receiveLlmMessages: jest.fn(async () => []),
      extendLlmVisibility: jest.fn(async () => undefined),
      deleteLlmMessage: jest.fn(async () => undefined),
    };
    const batchProcessor = {
      process: jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined),
    };
    const consumer = new SqsConsumerService(
      queue as never,
      batchProcessor as never,
      {
        process: jest.fn(),
      } as never,
      createConfig(),
    );

    consumer['running'] = true;
    await consumer['consumeBatchLoop']();

    expect(batchProcessor.process).toHaveBeenCalledTimes(2);
    expect(queue.deleteMessage).toHaveBeenCalledTimes(1);
    expect(queue.deleteMessage).toHaveBeenCalledWith('rh_2');
  });
});
