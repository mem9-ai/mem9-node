import { SQSServiceException } from '@aws-sdk/client-sqs';
import { AppError, gunzipJson } from '@mem9/shared';

import { DeepAnalysisSourcePreparationService } from './deep-analysis-source-preparation.service';

const input = {
  reportId: 'dar_1',
  apiKeyFingerprintHex: '01'.repeat(32),
  sourceSnapshotObjectKey: 'deep-analysis/reports/snapshot_1/source.json.gz',
  rawApiKey: 'test-only-key',
  traceId: 'req_1',
};
const fingerprint = Buffer.from(input.apiKeyFingerprintHex, 'hex');

function setup() {
  const repository = {
    claimDeepAnalysisExecution: jest.fn().mockResolvedValue('lease_source'),
    renewDeepAnalysisExecution: jest.fn().mockResolvedValue(true),
    updateDeepAnalysisExecution: jest.fn().mockResolvedValue(undefined),
    handoffDeepAnalysisExecution: jest.fn().mockResolvedValue(undefined),
    failRejectedDeepAnalysisEnqueue: jest.fn().mockResolvedValue(true),
    updateDeepAnalysisReport: jest.fn(),
  };
  const source = {
    fetchAllMemories: jest
      .fn()
      .mockResolvedValue([{ id: 'mem_1', content: 'Memory 1' }]),
  };
  const storage = { putCompressedJson: jest.fn().mockResolvedValue(undefined) };
  const queue = { enqueueLlmMessage: jest.fn().mockResolvedValue(undefined) };
  const service = new DeepAnalysisSourcePreparationService(
    repository as never,
    source as never,
    storage as never,
    queue as never,
  );
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  return { repository, source, storage, queue, service };
}

describe('deep analysis source preparation lease', () => {
  afterEach(() => jest.restoreAllMocks());

  it('publishes the source snapshot and transfers ownership before enqueue', async () => {
    const { service, repository, storage, queue } = setup();
    queue.enqueueLlmMessage.mockImplementation(async () => {
      expect(repository.handoffDeepAnalysisExecution).toHaveBeenCalledWith(
        'dar_1',
        fingerprint,
        'lease_source',
        1,
      );
    });
    await service.prepareAndEnqueue(input);
    expect(repository.claimDeepAnalysisExecution).toHaveBeenCalledWith(
      'dar_1',
      fingerprint,
      'source',
    );
    const snapshot = gunzipJson<{ memoryCount: number }>(
      storage.putCompressedJson.mock.calls[0]![1],
    );
    expect(snapshot.memoryCount).toBe(1);
    expect(queue.enqueueLlmMessage).toHaveBeenCalledWith({
      messageType: 'deep_report',
      reportId: 'dar_1',
      apiKeyFingerprintHex: input.apiKeyFingerprintHex,
      traceId: 'req_1',
    });
    expect(repository.updateDeepAnalysisReport).not.toHaveBeenCalled();
  });

  it('immediately fails a single definitively rejected send without retaining SDK error text', async () => {
    const { service, repository, queue } = setup();
    queue.enqueueLlmMessage.mockRejectedValue(new SQSServiceException({
      name: 'AccessDeniedException',
      $fault: 'client',
      $metadata: { httpStatusCode: 403, attempts: 1 },
      message: 'denied with test-only-key',
    }));
    await service.prepareAndEnqueue(input);
    expect(repository.failRejectedDeepAnalysisEnqueue).toHaveBeenCalledWith('dar_1', fingerprint);
    expect(JSON.stringify((service['logger'].error as jest.Mock).mock.calls)).not.toContain(input.rawApiKey);
  });

  it.each([
    { httpStatusCode: 403, attempts: 2 },
    { httpStatusCode: 403 },
    { httpStatusCode: 408, attempts: 1 },
    { httpStatusCode: 429, attempts: 1 },
    { httpStatusCode: 500, attempts: 1 },
  ])('preserves queued work when send outcome may be ambiguous: %j', async ($metadata) => {
    const { service, repository, queue } = setup();
    queue.enqueueLlmMessage.mockRejectedValue(new SQSServiceException({
      name: 'SqsError', $fault: 'client', $metadata,
    }));
    await service.prepareAndEnqueue(input);
    expect(repository.failRejectedDeepAnalysisEnqueue).not.toHaveBeenCalled();
  });

  it('records a source failure only through its own lease without retaining upstream error text', async () => {
    const { service, repository, source, queue } = setup();
    source.fetchAllMemories.mockRejectedValue(
      new Error('request failed with test-only-key'),
    );
    await service.prepareAndEnqueue(input);
    expect(repository.updateDeepAnalysisExecution).toHaveBeenLastCalledWith(
      'dar_1',
      fingerprint,
      'lease_source',
      expect.objectContaining({
        status: 'FAILED',
        errorCode: 'DEEP_ANALYSIS_SOURCE_PREP_FAILED',
        errorMessage: 'Failed to prepare deep analysis source snapshot',
      }),
    );
    expect(queue.enqueueLlmMessage).not.toHaveBeenCalled();
    expect(
      JSON.stringify((service['logger'].error as jest.Mock).mock.calls),
    ).not.toContain(input.rawApiKey);
  });

  it('does no upstream or storage work when the initial queued lease is expired or already claimed', async () => {
    const { service, repository, source, storage, queue } = setup();
    repository.claimDeepAnalysisExecution.mockResolvedValue(null);
    await service.prepareAndEnqueue(input);
    expect(source.fetchAllMemories).not.toHaveBeenCalled();
    expect(storage.putCompressedJson).not.toHaveBeenCalled();
    expect(queue.enqueueLlmMessage).not.toHaveBeenCalled();
  });

  it('stops after source fetch if its lease was lost, without uploading or resurrecting a failed report', async () => {
    const { service, repository, source, storage, queue } = setup();
    repository.renewDeepAnalysisExecution
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    await service.prepareAndEnqueue(input);
    expect(source.fetchAllMemories).toHaveBeenCalledTimes(1);
    expect(storage.putCompressedJson).not.toHaveBeenCalled();
    expect(queue.enqueueLlmMessage).not.toHaveBeenCalled();
    expect(
      repository.updateDeepAnalysisExecution.mock.calls.some(
        (call) => call[3].status === 'FAILED',
      ),
    ).toBe(false);
  });

  it('does not overwrite a fast worker when SQS send succeeds remotely but its response fails', async () => {
    const { service, repository, queue } = setup();
    queue.enqueueLlmMessage.mockRejectedValue(new Error('ambiguous send'));
    await service.prepareAndEnqueue(input);
    expect(repository.handoffDeepAnalysisExecution).toHaveBeenCalledTimes(1);
    expect(
      repository.updateDeepAnalysisExecution.mock.calls.some(
        (call) => call[3].status === 'FAILED',
      ),
    ).toBe(false);
    expect(repository.updateDeepAnalysisReport).not.toHaveBeenCalled();
  });

  it('does not enqueue if the snapshot handoff loses a race with expiry', async () => {
    const { service, repository, queue } = setup();
    repository.handoffDeepAnalysisExecution.mockRejectedValue(
      new AppError('lost', {
        statusCode: 409,
        code: 'DEEP_ANALYSIS_LEASE_LOST',
      }),
    );
    await service.prepareAndEnqueue(input);
    expect(queue.enqueueLlmMessage).not.toHaveBeenCalled();
  });
});
