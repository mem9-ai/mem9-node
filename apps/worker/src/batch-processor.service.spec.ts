import { canonicalizeBatchPayload, gzipJson, sha256Hex } from '@mem9/shared';

import { BatchProcessorService } from './batch-processor.service';

describe('batch processor service', () => {
  it('completes a stored batch containing a historical memory longer than 12,000 characters', async () => {
    const memories = [
      {
        id: 'mem_long',
        content: 'Review dashboards and preserve detailed rollout decisions. '.repeat(240),
        createdAt: '2026-03-20T00:00:00Z',
        metadata: {},
      },
      {
        id: 'mem_short',
        content: 'Prefer structured summaries.',
        createdAt: '2026-03-21T00:00:00Z',
        metadata: {},
      },
    ];
    expect(memories[0]!.content.length).toBeGreaterThan(12000);
    const message = {
      jobId: 'aj_long',
      batchIndex: 1,
      payloadObjectKey: 'analysis-jobs/aj_long/batches/1.json.gz',
      payloadHash: sha256Hex(canonicalizeBatchPayload(memories.length, memories)),
      memoryCount: memories.length,
      pipelineVersion: 'v1',
      taxonomyVersion: 'v1',
      llmEnabled: false,
      traceId: 'trace_long',
    };
    const repository = {
      getJob: jest.fn().mockResolvedValue({
        id: message.jobId,
        status: 'RUNNING',
        expectedTotalBatches: 1,
        completedBatches: 0,
        taxonomyVersion: 'v1',
      }),
      getBatch: jest.fn().mockResolvedValue({ ...message, status: 'QUEUED' }),
      markBatchRunning: jest.fn(),
      markBatchSucceeded: jest.fn(),
      markBatchFailure: jest.fn(),
    };
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(0),
      rpush: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      multi: jest.fn(() => ({
        sadd: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[null, 1], [null, 1], [null, 1], [null, 1]]),
      })),
      eval: jest.fn().mockResolvedValue([
        JSON.stringify({ completedBatches: 1 }),
        '{}',
        '{}',
      ]),
    };
    const storage = {
      getObjectBuffer: jest.fn().mockResolvedValue(gzipJson({
        jobId: message.jobId,
        batchIndex: message.batchIndex,
        memoryCount: memories.length,
        memories,
      })),
    };
    const taxonomyCache = { getRules: jest.fn().mockResolvedValue([]) };
    const processor = new BatchProcessorService(
      repository as never,
      redis as never,
      storage as never,
      taxonomyCache as never,
    );

    await expect(processor.process(message, 1)).resolves.toBeUndefined();

    expect(repository.markBatchFailure).not.toHaveBeenCalled();
    expect(repository.markBatchSucceeded).toHaveBeenCalledWith(expect.objectContaining({
      jobId: message.jobId,
      processedMemories: 2,
      finalStatus: 'COMPLETED',
    }));
  });

  it('skips batches belonging to a cancelled job', async () => {
    const repository = {
      getJob: jest.fn(async () => ({
        id: 'aj_cancelled',
        status: 'CANCELLED',
        expectedTotalBatches: 1,
        completedBatches: 0,
        taxonomyVersion: 'v1',
      })),
      getBatch: jest.fn(async () => ({
        id: 'ajb_1',
        status: 'QUEUED',
        memoryCount: 1,
      })),
      markBatchRunning: jest.fn(),
    };
    const redis = {
      set: jest.fn(async () => 'OK'),
      get: jest.fn(async (key: string) => (key.startsWith('lock:') ? 'lock_1' : null)),
      del: jest.fn(async () => 1),
    };
    const storage = {
      getObjectBuffer: jest.fn(),
    };
    const processor = new BatchProcessorService(
      repository as never,
      redis as never,
      storage as never,
      {} as never,
    );

    await processor.process(
      {
        jobId: 'aj_cancelled',
        batchIndex: 1,
        payloadObjectKey: 'analysis-jobs/aj_cancelled/batches/1.json.gz',
        payloadHash: 'hash',
        memoryCount: 1,
        pipelineVersion: 'v1',
        taxonomyVersion: 'v1',
        llmEnabled: false,
        traceId: 'trace_1',
      },
      1,
    );

    expect(repository.markBatchRunning).not.toHaveBeenCalled();
    expect(storage.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('skips already succeeded batches without touching S3', async () => {
    const repository = {
      getJob: jest.fn(async () => ({
        id: 'aj_1',
        expectedTotalBatches: 1,
        completedBatches: 1,
        taxonomyVersion: 'v1',
      })),
      getBatch: jest.fn(async () => ({
        id: 'ajb_1',
        status: 'SUCCEEDED',
        memoryCount: 1,
      })),
    };
    const redis = {
      set: jest.fn(async () => 'OK'),
      get: jest.fn(async (key: string) => (key.startsWith('lock:') ? 'lock_1' : null)),
      del: jest.fn(async () => 1),
      exists: jest.fn(async () => 0),
    };
    const storage = {
      getObjectBuffer: jest.fn(),
    };
    const taxonomyCache = {
      getRules: jest.fn(),
    };
    const processor = new BatchProcessorService(
      repository as never,
      redis as never,
      storage as never,
      taxonomyCache as never,
    );

    await processor.process(
      {
        jobId: 'aj_1',
        batchIndex: 1,
        payloadObjectKey: 'analysis-jobs/aj_1/batches/1.json.gz',
        payloadHash: 'hash',
        memoryCount: 1,
        pipelineVersion: 'v1',
        taxonomyVersion: 'v1',
        llmEnabled: false,
        traceId: 'trace_1',
      },
      1,
    );

    expect(storage.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('marks failures when payload loading throws', async () => {
    const repository = {
      getJob: jest.fn(async () => ({
        id: 'aj_1',
        expectedTotalBatches: 1,
        completedBatches: 0,
        taxonomyVersion: 'v1',
      })),
      getBatch: jest.fn(async () => ({
        id: 'ajb_1',
        status: 'QUEUED',
        memoryCount: 1,
      })),
      markBatchRunning: jest.fn(async () => undefined),
      markBatchFailure: jest.fn(async () => undefined),
    };
    const redis = {
      set: jest.fn(async () => 'OK'),
      get: jest.fn(async (key: string) => (key.startsWith('lock:') ? 'lock_1' : null)),
      del: jest.fn(async () => 1),
      exists: jest.fn(async () => 0),
      rpush: jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
      multi: jest.fn(() => ({
        sadd: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn(async () => [[null, 1], [null, 1], [null, 1], [null, 1]]),
      })),
      eval: jest.fn(),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const taxonomyCache = {
      getRules: jest.fn(),
    };
    const processor = new BatchProcessorService(
      repository as never,
      redis as never,
      storage as never,
      taxonomyCache as never,
    );

    await expect(
      processor.process(
        {
          jobId: 'aj_1',
          batchIndex: 1,
          payloadObjectKey: 'analysis-jobs/aj_1/batches/1.json.gz',
          payloadHash: 'hash',
          memoryCount: 1,
          pipelineVersion: 'v1',
          taxonomyVersion: 'v1',
          llmEnabled: false,
          traceId: 'trace_1',
        },
        3,
      ),
    ).rejects.toThrow('boom');

    expect(repository.markBatchFailure).toHaveBeenCalled();
  });
});
