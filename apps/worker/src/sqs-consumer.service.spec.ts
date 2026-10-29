import type { AppConfig } from '@mem9/config';
import { AppError } from '@mem9/shared';
import * as Sentry from '@sentry/nestjs';

import { SqsConsumerService } from './sqs-consumer.service';

const TEST_QWEN_MODEL = 'test-qwen-model';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

function createConfig(overrides?: Partial<AppConfig['sqs']>): AppConfig {
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
      timeoutMs: 3000,
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
    jest.clearAllMocks();
    jest.restoreAllMocks();
    jest.useRealTimers();
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
              apiKeyFingerprintHex: '01'.repeat(32),
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
      {
        process: jest.fn(),
      } as never,
      createConfig(),
    );
    const errorSpy = jest
      .spyOn(consumer['logger'], 'error')
      .mockImplementation(() => undefined);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    consumer['running'] = true;
    await consumer['consumeBatchLoop']();

    expect(batchProcessor.process).toHaveBeenCalledTimes(1);
    expect(batchProcessor.process).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyFingerprintHex: '01'.repeat(32) }),
      2,
    );
    expect(queue.deleteMessage).toHaveBeenCalledWith('rh_good');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 7000);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Queue operation failed', code: 'QUEUE_MESSAGE_INVALID_JSON' }),
      { tags: { event: 'queue_message_parse_failed', queue: 'batch' } },
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it('keeps consuming after one processor failure', async () => {
    const queue = {
      receiveBatchMessages: jest
        .fn()
        .mockResolvedValueOnce([
          {
            Body: JSON.stringify({
              apiKeyFingerprintHex: '01'.repeat(32),
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
              apiKeyFingerprintHex: '02'.repeat(32),
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
      {
        process: jest.fn(),
      } as never,
      createConfig(),
    );
    const errorSpy = jest
      .spyOn(consumer['logger'], 'error')
      .mockImplementation(() => undefined);

    consumer['running'] = true;
    await consumer['consumeBatchLoop']();

    expect(batchProcessor.process).toHaveBeenCalledTimes(2);
    expect(queue.deleteMessage).toHaveBeenCalledTimes(1);
    expect(queue.deleteMessage).toHaveBeenCalledWith('rh_2');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Queue operation failed', code: 'QUEUE_MESSAGE_PROCESSING_FAILED' }),
      { tags: { event: 'queue_message_processing_failed', queue: 'batch' } },
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it('dispatches deep report messages with their tenant fingerprint', async () => {
    const message = {
      messageType: 'deep_report',
      reportId: 'dar_1',
      apiKeyFingerprintHex: '01'.repeat(32),
      traceId: 'trace_deep',
    };
    const queue = {
      receiveLlmMessages: jest
        .fn()
        .mockResolvedValueOnce([{
          Body: JSON.stringify(message),
          ReceiptHandle: 'rh_deep',
        }])
        .mockImplementationOnce(async () => {
          consumerLoop.running = false;
          return [];
        }),
      extendLlmVisibility: jest.fn(async () => undefined),
      deleteLlmMessage: jest.fn(async () => undefined),
    };
    const deepAnalysisProcessor = {
      process: jest.fn(async () => undefined),
    };
    const consumer = new SqsConsumerService(
      queue as never,
      { process: jest.fn() } as never,
      deepAnalysisProcessor as never,
      { process: jest.fn() } as never,
      createConfig(),
    );
    const consumerLoop = consumer as unknown as {
      running: boolean;
      consumeLlmLoop(): Promise<void>;
    };

    consumerLoop.running = true;
    await consumerLoop.consumeLlmLoop();

    expect(deepAnalysisProcessor.process).toHaveBeenCalledWith(message);
    expect(queue.deleteLlmMessage).toHaveBeenCalledWith('rh_deep');
  });

  it('dispatches memory analysis report llm messages', async () => {
    let consumer: SqsConsumerService;
    const queue = {
      receiveBatchMessages: jest.fn(async () => []),
      extendVisibility: jest.fn(async () => undefined),
      deleteMessage: jest.fn(async () => undefined),
      receiveLlmMessages: jest
        .fn()
        .mockResolvedValueOnce([
          {
            Body: JSON.stringify({
              messageType: 'memory_analysis_report',
              reportId: 12,
              apiKeyFingerprintHex: Buffer.alloc(32, 4).toString('hex'),
              encryptedApiKey: 'encrypted-test-envelope',
              createdAfter: '2026-06-01T00:00:00.000Z',
              createdBefore: '2026-06-14T23:59:59.999Z',
              traceId: 'trace_memory',
            }),
            ReceiptHandle: 'rh_memory',
            Attributes: { ApproximateReceiveCount: '1' },
          },
        ])
        .mockImplementationOnce(async () => {
          consumer['running'] = false;
          return [];
        }),
      extendLlmVisibility: jest.fn(async () => undefined),
      deleteLlmMessage: jest.fn(async () => undefined),
    };
    const memoryAnalysisProcessor = {
      process: jest.fn(async () => undefined),
    };
    consumer = new SqsConsumerService(
      queue as never,
      {
        process: jest.fn(),
      } as never,
      {
        process: jest.fn(),
      } as never,
      memoryAnalysisProcessor as never,
      createConfig(),
    );

    consumer['running'] = true;
    await consumer['consumeLlmLoop']();

    expect(memoryAnalysisProcessor.process).toHaveBeenCalledWith({
      messageType: 'memory_analysis_report',
      reportId: 12,
      apiKeyFingerprintHex: Buffer.alloc(32, 4).toString('hex'),
      encryptedApiKey: 'encrypted-test-envelope',
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
      traceId: 'trace_memory',
    });
    expect(queue.deleteLlmMessage).toHaveBeenCalledWith('rh_memory');
  });

  function isolatedConsumer() {
    const consumer = new SqsConsumerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createConfig(),
    );
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Test-only access to the private logger.
    const errorSpy = jest.spyOn(consumer['logger'], 'error').mockImplementation(() => undefined);
    return { consumer, errorSpy };
  }

  function expectSafeCapture(original: unknown, secrets: string[]) {
    const [captured, context] = jest.mocked(Sentry.captureException).mock.calls[0]!;
    expect(captured).not.toBe(original);
    expect(captured).toBeInstanceOf(AppError);
    const error = captured as AppError;
    expect(error.message).toBe('Queue operation failed');
    expect(error.cause).toBeUndefined();
    expect(error.details).toBeUndefined();
    const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack, context });
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  }

  it('does not expose a malformed legacy body or its receipt handle through parse errors', async () => {
    const secret = 'legacy-credential-sentinel';
    const receipt = 'private-receipt-sentinel';
    const body = `{"rawApiKey":"${secret}",`;
    const { consumer, errorSpy } = isolatedConsumer();
    const processMessage = jest.fn(async () => undefined);
    const deleteMessage = jest.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Exercise the private message boundary in isolation.
    await consumer['handleMessage']({
      message: { Body: body, ReceiptHandle: receipt },
      extendVisibility: jest.fn(async () => undefined),
      deleteMessage,
      parseBody: JSON.parse,
      processMessage,
      loopName: 'llm',
    });
    expect(processMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expectSafeCapture(undefined, [secret, receipt, body]);
    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string)).toMatchInlineSnapshot(`
{
  "code": "QUEUE_MESSAGE_INVALID_JSON",
  "event": "queue_message_parse_failed",
  "queue": "llm",
}
`);
    expect(errorSpy.mock.calls[0]).toHaveLength(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(receipt);
  });

  it.each([
    ['INVALID_QUEUE_CREDENTIAL', 'INVALID_QUEUE_CREDENTIAL'],
    ['arbitrary-secret-error-code', 'QUEUE_MESSAGE_PROCESSING_FAILED'],
  ])('retains only allowlisted processing codes: %s', async (code, expectedCode) => {
    const secret = 'decrypted-credential-sentinel';
    const receipt = 'private-processing-receipt';
    const envelope = 'private-encrypted-envelope';
    const error = new AppError(`Provider returned ${secret}`, {
      statusCode: 403,
      code,
      details: { rawApiKey: secret, encryptedApiKey: envelope, receipt },
      cause: new Error(`Nested failure ${secret}`),
    });
    error.stack = `Error stack containing ${secret} and ${envelope}`;
    const { consumer, errorSpy } = isolatedConsumer();
    const deleteMessage = jest.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Exercise the private message boundary in isolation.
    await consumer['handleMessage']({
      message: { Body: JSON.stringify({ encryptedApiKey: envelope }), ReceiptHandle: receipt },
      extendVisibility: jest.fn(async () => undefined),
      deleteMessage,
      parseBody: JSON.parse,
      processMessage: jest.fn(async () => { throw error; }),
      loopName: 'llm',
    });
    expect(deleteMessage).not.toHaveBeenCalled();
    expectSafeCapture(error, [secret, receipt, envelope, 'arbitrary-secret-error-code']);
    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string)).toEqual({
      event: 'queue_message_processing_failed', queue: 'llm', code: expectedCode,
    });
    expect(errorSpy.mock.calls[0]).toHaveLength(1);
    const output = JSON.stringify(errorSpy.mock.calls);
    for (const value of [secret, receipt, envelope, 'arbitrary-secret-error-code']) {
      expect(output).not.toContain(value);
    }
  });

  it('sanitizes arbitrary thrown values and acknowledgment failures', async () => {
    const { consumer, errorSpy } = isolatedConsumer();
    const receipt = 'private-delete-receipt';
    const secret = 'sdk-error-credential';
    const processMessage = jest.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Exercise the private message boundary in isolation.
    await consumer['handleMessage']({
      message: { Body: '{}', ReceiptHandle: receipt },
      extendVisibility: jest.fn(async () => undefined),
      deleteMessage: jest.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Verify sanitization of arbitrary SDK rejection values.
        throw { rawApiKey: secret, ReceiptHandle: receipt };
      }),
      parseBody: JSON.parse,
      processMessage,
      loopName: 'llm',
    });
    expect(processMessage).toHaveBeenCalledTimes(1);
    expectSafeCapture(undefined, [secret, receipt]);
    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string)).toMatchInlineSnapshot(`
{
  "code": "QUEUE_MESSAGE_PROCESSING_FAILED",
  "event": "queue_message_processing_failed",
  "queue": "llm",
}
`);
  });

  it('handles heartbeat errors without leaking receipt handles or creating unhandled rejections', async () => {
    jest.useFakeTimers();
    const { consumer, errorSpy } = isolatedConsumer();
    const receipt = 'private-heartbeat-receipt';
    const secret = 'heartbeat-credential-sentinel';
    const error = new Error(`SDK failure ${receipt} ${secret}`);
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => { finishWork = resolve; });
    const deleteMessage = jest.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Exercise the private message boundary in isolation.
    const processing = consumer['handleMessage']({
      message: { Body: '{}', ReceiptHandle: receipt },
      extendVisibility: jest.fn(async () => { throw error; }),
      deleteMessage,
      parseBody: JSON.parse,
      processMessage: () => work,
      loopName: 'llm',
    });
    await jest.advanceTimersByTimeAsync(7000);
    finishWork();
    await processing;
    expectSafeCapture(error, [secret, receipt]);
    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string)).toMatchInlineSnapshot(`
{
  "code": "QUEUE_VISIBILITY_EXTENSION_FAILED",
  "event": "queue_visibility_extension_failed",
  "queue": "llm",
}
`);
    expect(deleteMessage).toHaveBeenCalledWith(receipt);
    expect(jest.getTimerCount()).toBe(0);
  });

});
