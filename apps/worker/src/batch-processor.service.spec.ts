import { BatchProcessorService } from './batch-processor.service';

describe('batch processor service', () => {
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
