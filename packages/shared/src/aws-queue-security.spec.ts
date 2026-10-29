import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AnalysisBatchMessage, AnalysisLlmQueueMessage, MemoryAnalysisReportMessage } from '@mem9/contracts';

import { SqsQueueService } from './aws.service';
import { decryptQueueCredential, encryptQueueCredential } from './queue-credentials';

const keys = `test:${Buffer.alloc(32, 1).toString('base64')}`;
const rawApiKey = 'synthetic-queue-credential-never-send';
const scope = {
  reportId: 42,
  apiKeyFingerprintHex: Buffer.alloc(32, 2).toString('hex'),
  createdAfter: '2026-06-01T00:00:00.000Z',
  createdBefore: '2026-06-02T00:00:00.000Z',
};

function memoryMessage(): MemoryAnalysisReportMessage {
  return {
    messageType: 'memory_analysis_report',
    ...scope,
    encryptedApiKey: encryptQueueCredential(keys, rawApiKey, scope),
    traceId: 'queue-security-test',
  };
}

const batch: AnalysisBatchMessage = {
  apiKeyFingerprintHex: scope.apiKeyFingerprintHex,
  jobId: 'job-test',
  batchIndex: 0,
  payloadObjectKey: 'test/payload.json.gz',
  payloadHash: 'payload-hash',
  memoryCount: 1,
  pipelineVersion: 'v1',
  taxonomyVersion: 'v1',
  llmEnabled: true,
  traceId: 'batch-test',
};
const llm: AnalysisLlmQueueMessage = {
  messageType: 'analysis_llm',
  jobId: 'job-test',
  batchIndex: 0,
  memoryIds: ['memory-test'],
  taxonomyVersion: 'v1',
  traceId: 'llm-test',
};
const deep: AnalysisLlmQueueMessage = {
  messageType: 'deep_report',
  reportId: 'dar-test',
  apiKeyFingerprintHex: scope.apiKeyFingerprintHex,
  traceId: 'deep-test',
};

function queueService() {
  const send = jest.fn<Promise<void>, [SendMessageCommand]>(async () => undefined);
  const service = new SqsQueueService({
    sqs: { send },
    settings: {
      aws: { sqsAnalysisBatchQueueUrl: 'https://sqs.test/batch', sqsAnalysisLlmQueueUrl: 'https://sqs.test/llm' },
    },
  } as never);
  return { service, send };
}

describe('SQS credential boundary', () => {
  it('sends an encrypted, scope-bound memory credential and only the allowed fields', async () => {
    const { service, send } = queueService();
    const message = memoryMessage();
    await service.enqueueLlmMessage({
      ...message,
      accidentalRequestSecret: rawApiKey,
      requestContext: { authorization: rawApiKey },
    } as MemoryAnalysisReportMessage);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input.QueueUrl).toBe('https://sqs.test/llm');
    expect(command.input.MessageBody).not.toContain(rawApiKey);
    expect(command.input.MessageBody).not.toContain('rawApiKey');
    const body = JSON.parse(command.input.MessageBody!) as MemoryAnalysisReportMessage;
    expect(body).toEqual(message);
    expect(decryptQueueCredential(keys, body.encryptedApiKey, body)).toBe(rawApiKey);
    expect(() => decryptQueueCredential(keys, body.encryptedApiKey, { ...body, reportId: 43 }))
      .toThrow('Invalid queue credential');
  });

  it.each([
    ['memory', () => ({ ...memoryMessage(), rawApiKey })],
    ['memory undefined raw field', () => ({ ...memoryMessage(), rawApiKey: undefined })],
    ['memory nested raw field', () => ({ ...memoryMessage(), extra: [{ rawApiKey }] })],
    ['legacy memory', () => ({ ...scope, messageType: 'memory_analysis_report', traceId: 'old', rawApiKey })],
    ['deep', () => ({ ...deep, rawApiKey })],
    ['LLM', () => ({ ...llm, rawApiKey })],
    ['LLM toJSON', () => ({ ...llm, extra: { toJSON: () => ({ rawApiKey }) } })],
    ['memory non-enumerable raw field', () => Object.defineProperty(memoryMessage(), 'rawApiKey', { value: rawApiKey })],
  ] as const)('rejects %s plaintext fields before calling the SDK', async (_label, createMessage) => {
    const { service, send } = queueService();
    await expect(service.enqueueLlmMessage(createMessage() as AnalysisLlmQueueMessage))
      .rejects.toMatchObject({ code: 'INVALID_QUEUE_MESSAGE', cause: undefined });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects plaintext credentials on batch messages too', async () => {
    const { service, send } = queueService();
    await expect(service.enqueueBatch({ ...batch, rawApiKey } as AnalysisBatchMessage))
      .rejects.toMatchObject({ code: 'INVALID_QUEUE_MESSAGE' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, '', { token: rawApiKey }])('rejects missing or non-string encrypted credentials', async (encryptedApiKey) => {
    const { service, send } = queueService();
    await expect(service.enqueueLlmMessage({ ...memoryMessage(), encryptedApiKey } as MemoryAnalysisReportMessage))
      .rejects.toMatchObject({ code: 'INVALID_QUEUE_MESSAGE' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not invoke payload accessors or expose their errors', async () => {
    const { service, send } = queueService();
    const getter = jest.fn(() => { throw new Error(rawApiKey); });
    const message = Object.defineProperty(memoryMessage(), 'extra', { get: getter });
    const error: unknown = await service.enqueueLlmMessage(message).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'INVALID_QUEUE_MESSAGE', cause: undefined });
    expect(JSON.stringify(error)).not.toContain(rawApiKey);
    expect(getter).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves normal batch, analysis-LLM, and deep-report messages', async () => {
    const { service, send } = queueService();
    await service.enqueueBatch(batch);
    await service.enqueueLlmMessage(llm);
    await service.enqueueLlmMessage(deep);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { QueueUrl: 'https://sqs.test/batch', MessageBody: JSON.stringify(batch) },
      { QueueUrl: 'https://sqs.test/llm', MessageBody: JSON.stringify(llm) },
      { QueueUrl: 'https://sqs.test/llm', MessageBody: JSON.stringify(deep) },
    ]);
  });
});
