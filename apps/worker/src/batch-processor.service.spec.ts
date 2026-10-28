import type { AnalysisBatchMessage } from '@mem9/contracts';
import { canonicalizeBatchPayload, gzipJson, sha256Hex } from '@mem9/shared';

import { BatchProcessorService } from './batch-processor.service';

function createIsolationFixture() {
  const memories = [{ id: 'mem_1', content: 'Synthetic memory', createdAt: '2026-01-01T00:00:00Z', metadata: {} }];
  const message: AnalysisBatchMessage = {
    apiKeyFingerprintHex: '01'.repeat(32),
    jobId: 'aj_owned',
    batchIndex: 1,
    payloadObjectKey: 'analysis-jobs/aj_owned/batches/1.json.gz',
    payloadHash: sha256Hex(canonicalizeBatchPayload(1, memories)),
    memoryCount: 1,
    pipelineVersion: 'v1',
    taxonomyVersion: 'v1',
    llmEnabled: false,
    traceId: 'trace',
  };
  const payload = { jobId: message.jobId, batchIndex: 1, memoryCount: 1, memories };
  const batch = { ...message, status: 'QUEUED' };
  const repository = {
    getOwnedJob: jest.fn().mockResolvedValue({
      id: message.jobId, status: 'PROCESSING', expectedTotalBatches: 1, completedBatches: 0, taxonomyVersion: 'v1',
    }),
    getBatch: jest.fn().mockResolvedValue(batch),
    markBatchRunning: jest.fn(),
    markBatchSucceeded: jest.fn(),
    markBatchFailure: jest.fn(),
  };
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn(),
    exists: jest.fn().mockResolvedValue(0),
    rpush: jest.fn(),
    expire: jest.fn(),
    multi: jest.fn(),
    eval: jest.fn(),
  };
  const storage = { getObjectBuffer: jest.fn().mockResolvedValue(gzipJson(payload)) };
  const taxonomyCache = { getRules: jest.fn() };
  const processor = new BatchProcessorService(repository as never, redis as never, storage as never, taxonomyCache as never);
  const expectNoSideEffects = () => {
    for (const operation of Object.values(redis)) expect(operation).not.toHaveBeenCalled();
    expect(storage.getObjectBuffer).not.toHaveBeenCalled();
    expect(taxonomyCache.getRules).not.toHaveBeenCalled();
    expect(repository.markBatchRunning).not.toHaveBeenCalled();
    expect(repository.markBatchSucceeded).not.toHaveBeenCalled();
    expect(repository.markBatchFailure).not.toHaveBeenCalled();
  };
  return { message, payload, batch, repository, redis, storage, taxonomyCache, processor, expectNoSideEffects };
}

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
      apiKeyFingerprintHex: '01'.repeat(32),
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
      getOwnedJob: jest.fn().mockResolvedValue({
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

    expect(repository.getOwnedJob).toHaveBeenCalledWith(message.jobId, Buffer.from(message.apiKeyFingerprintHex, 'hex'));
    expect(repository.markBatchFailure).not.toHaveBeenCalled();
    expect(repository.markBatchSucceeded).toHaveBeenCalledWith(expect.objectContaining({
      jobId: message.jobId,
      processedMemories: 2,
      finalStatus: 'COMPLETED',
    }));
  });

  it('skips batches belonging to a cancelled job', async () => {
    const repository = {
      getOwnedJob: jest.fn(async () => ({
        id: 'aj_cancelled',
        status: 'CANCELLED',
        expectedTotalBatches: 1,
        completedBatches: 0,
        taxonomyVersion: 'v1',
      })),
      getBatch: jest.fn(async () => ({
        id: 'ajb_1',
        jobId: 'aj_cancelled',
        batchIndex: 1,
        payloadObjectKey: 'analysis-jobs/aj_cancelled/batches/1.json.gz',
        payloadHash: 'a'.repeat(64),
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
        apiKeyFingerprintHex: '01'.repeat(32),
        jobId: 'aj_cancelled',
        batchIndex: 1,
        payloadObjectKey: 'analysis-jobs/aj_cancelled/batches/1.json.gz',
        payloadHash: 'a'.repeat(64),
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
      getOwnedJob: jest.fn(async () => ({
        id: 'aj_1',
        expectedTotalBatches: 1,
        completedBatches: 1,
        taxonomyVersion: 'v1',
      })),
      getBatch: jest.fn(async () => ({
        id: 'ajb_1',
        jobId: 'aj_1',
        batchIndex: 1,
        payloadObjectKey: 'analysis-jobs/aj_1/batches/1.json.gz',
        payloadHash: 'a'.repeat(64),
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
        apiKeyFingerprintHex: '01'.repeat(32),
        jobId: 'aj_1',
        batchIndex: 1,
        payloadObjectKey: 'analysis-jobs/aj_1/batches/1.json.gz',
        payloadHash: 'a'.repeat(64),
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
      getOwnedJob: jest.fn(async () => ({
        id: 'aj_1',
        expectedTotalBatches: 1,
        completedBatches: 0,
        taxonomyVersion: 'v1',
      })),
      getBatch: jest.fn(async () => ({
        id: 'ajb_1',
        jobId: 'aj_1',
        batchIndex: 1,
        payloadObjectKey: 'analysis-jobs/aj_1/batches/1.json.gz',
        payloadHash: 'a'.repeat(64),
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
          apiKeyFingerprintHex: '01'.repeat(32),
          jobId: 'aj_1',
          batchIndex: 1,
          payloadObjectKey: 'analysis-jobs/aj_1/batches/1.json.gz',
          payloadHash: 'a'.repeat(64),
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

describe('batch queue isolation', () => {
  it('counts a completed batch once when a duplicate acquires its lock after another consumer finishes', async () => {
    const fixture = createIsolationFixture();
    let releaseBothPrechecks!: () => void;
    const bothPrechecks = new Promise<void>((resolve) => { releaseBothPrechecks = resolve; });
    let releaseFirstLock!: () => void;
    const firstLockReleased = new Promise<void>((resolve) => { releaseFirstLock = resolve; });
    let lockToken: string | null = null;
    let acquisitions = 0;
    let storedStatus = 'QUEUED';
    let completedBatches = 0;
    let processedMemories = 0;
    const statusesRead: string[] = [];
    fixture.repository.getOwnedJob.mockImplementation(async () => ({
      id: fixture.message.jobId, status: 'PROCESSING', expectedTotalBatches: 1, completedBatches, taxonomyVersion: 'v1',
    }));
    fixture.repository.getBatch.mockImplementation(async () => {
      statusesRead.push(storedStatus);
      return { ...fixture.batch, status: storedStatus };
    });
    fixture.repository.markBatchSucceeded.mockImplementation(async (data: { processedMemories: number }) => {
      storedStatus = 'SUCCEEDED';
      completedBatches++;
      processedMemories += data.processedMemories;
    });
    fixture.redis.set.mockImplementation(async (_key: string, token: string) => {
      acquisitions++;
      if (acquisitions === 1) {
        // Hold the first SET response until both consumers read QUEUED.
        await bothPrechecks;
      } else {
        releaseBothPrechecks();
        // The duplicate's SET reaches Redis only after the first release.
        await firstLockReleased;
      }
      lockToken = token;
      return 'OK';
    });
    fixture.redis.get.mockImplementation(async () => lockToken);
    fixture.redis.del.mockImplementation(async () => {
      lockToken = null;
      releaseFirstLock();
      return 1;
    });
    fixture.redis.exists.mockResolvedValue(1);

    await Promise.all([
      fixture.processor.process(fixture.message, 1),
      fixture.processor.process(fixture.message, 2),
    ]);

    expect(statusesRead).toEqual(['QUEUED', 'QUEUED', 'QUEUED', 'SUCCEEDED']);
    expect(fixture.repository.markBatchSucceeded).toHaveBeenCalledTimes(1);
    expect(completedBatches).toBe(1);
    expect(processedMemories).toBe(1);
    expect(fixture.redis.exists).toHaveBeenCalledTimes(1);
    expect(fixture.redis.del).toHaveBeenCalledTimes(2);
    expect(fixture.repository.markBatchFailure).not.toHaveBeenCalled();
    expect(fixture.storage.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('observes cancellation after acquiring the lock and releases it without processing', async () => {
    const fixture = createIsolationFixture();
    let lockToken: string | null = null;
    let status = 'PROCESSING';
    fixture.repository.getOwnedJob.mockImplementation(async () => ({
      id: fixture.message.jobId, status, expectedTotalBatches: 1, completedBatches: 0, taxonomyVersion: 'v1',
    }));
    fixture.redis.set.mockImplementation(async (_key: string, token: string) => {
      lockToken = token;
      status = 'CANCELLED';
      return 'OK';
    });
    fixture.redis.get.mockImplementation(async () => lockToken);

    await fixture.processor.process(fixture.message, 1);

    expect(fixture.repository.getOwnedJob).toHaveBeenCalledTimes(2);
    expect(fixture.repository.getBatch).toHaveBeenCalledTimes(2);
    expect(fixture.redis.del).toHaveBeenCalledTimes(1);
    expect(fixture.redis.exists).not.toHaveBeenCalled();
    expect(fixture.storage.getObjectBuffer).not.toHaveBeenCalled();
    expect(fixture.repository.markBatchRunning).not.toHaveBeenCalled();
    expect(fixture.repository.markBatchSucceeded).not.toHaveBeenCalled();
    expect(fixture.repository.markBatchFailure).not.toHaveBeenCalled();
  });

  it.each(['owner lookup', 'manifest lookup', 'missing batch', 'changed manifest'])('releases the lock without failure bookkeeping when revalidation fails: %s', async (failure) => {
    const fixture = createIsolationFixture();
    let lockToken: string | null = null;
    fixture.redis.set.mockImplementation(async (_key: string, token: string) => {
      lockToken = token;
      if (failure === 'owner lookup') fixture.repository.getOwnedJob.mockRejectedValue(new Error('not owned'));
      if (failure === 'manifest lookup') fixture.repository.getBatch.mockRejectedValue(new Error('database unavailable'));
      if (failure === 'missing batch') fixture.repository.getBatch.mockResolvedValue(null);
      if (failure === 'changed manifest') fixture.repository.getBatch.mockResolvedValue({ ...fixture.batch, payloadHash: 'b'.repeat(64) });
      return 'OK';
    });
    fixture.redis.get.mockImplementation(async () => lockToken);

    await expect(fixture.processor.process(fixture.message, 1)).rejects.toThrow();

    expect(fixture.repository.getOwnedJob).toHaveBeenCalledTimes(2);
    expect(fixture.redis.del).toHaveBeenCalledTimes(1);
    expect(fixture.redis.exists).not.toHaveBeenCalled();
    expect(fixture.redis.rpush).not.toHaveBeenCalled();
    expect(fixture.storage.getObjectBuffer).not.toHaveBeenCalled();
    expect(fixture.taxonomyCache.getRules).not.toHaveBeenCalled();
    expect(fixture.repository.markBatchRunning).not.toHaveBeenCalled();
    expect(fixture.repository.markBatchSucceeded).not.toHaveBeenCalled();
    expect(fixture.repository.markBatchFailure).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '01', 'g'.repeat(64), '01'.repeat(32) + 'junk', '01'.repeat(32) + '\n'])('rejects an absent or malformed owner %p before lookup', async (owner) => {
    const fixture = createIsolationFixture();
    await expect(fixture.processor.process({ ...fixture.message, apiKeyFingerprintHex: owner } as AnalysisBatchMessage, 1)).rejects.toThrow();
    expect(fixture.repository.getOwnedJob).not.toHaveBeenCalled();
    expect(fixture.repository.getBatch).not.toHaveBeenCalled();
    fixture.expectNoSideEffects();
  });

  it.each([
    { batchIndex: 0 }, { batchIndex: 1.5 }, { memoryCount: -1 }, { memoryCount: '1' },
    { jobId: undefined }, { payloadHash: 'invalid' }, { payloadHash: 'A'.repeat(64) }, { payloadHash: 'a'.repeat(64) + '\n' },
  ])('rejects malformed routing or hash metadata %p before lookup', async (override) => {
    const fixture = createIsolationFixture();
    await expect(fixture.processor.process({ ...fixture.message, ...override } as AnalysisBatchMessage, 1))
      .rejects.toMatchObject({ code: 'INVALID_BATCH_MESSAGE' });
    expect(fixture.repository.getOwnedJob).not.toHaveBeenCalled();
    fixture.expectNoSideEffects();
  });

  it.each([null, [], 'not-an-object'])('rejects a non-message JSON body %p without side effects', async (body) => {
    const fixture = createIsolationFixture();
    await expect(fixture.processor.process(body as unknown as AnalysisBatchMessage, 1)).rejects.toMatchObject({ code: 'INVALID_BATCH_MESSAGE' });
    fixture.expectNoSideEffects();
  });

  it('rejects a different tenant before fetching the batch or recording failure', async () => {
    const fixture = createIsolationFixture();
    fixture.repository.getOwnedJob.mockRejectedValue(new Error('not owned'));
    const foreignOwner = '02'.repeat(32);
    await expect(fixture.processor.process({ ...fixture.message, apiKeyFingerprintHex: foreignOwner }, 1)).rejects.toThrow('not owned');
    expect(fixture.repository.getOwnedJob).toHaveBeenCalledWith(fixture.message.jobId, Buffer.from(foreignOwner, 'hex'));
    expect(fixture.repository.getBatch).not.toHaveBeenCalled();
    fixture.expectNoSideEffects();
  });

  it.each([
    { payloadObjectKey: 'analysis-jobs/another-tenant/batches/1.json.gz' },
    { payloadHash: 'b'.repeat(64) },
    { memoryCount: 2 },
  ])('rejects substituted manifest metadata %p before locks or S3', async (override) => {
    const fixture = createIsolationFixture();
    await expect(fixture.processor.process({ ...fixture.message, ...override }, 1)).rejects.toMatchObject({ code: 'INVALID_BATCH_MESSAGE' });
    fixture.expectNoSideEffects();
  });

  it.each([null, { jobId: 'aj_other' }, { batchIndex: 2 }])('rejects a missing or mismatched persisted batch %p', async (override) => {
    const fixture = createIsolationFixture();
    fixture.repository.getBatch.mockResolvedValue(override === null ? null : { ...fixture.batch, ...override });
    await expect(fixture.processor.process(fixture.message, 1)).rejects.toMatchObject({ code: 'INVALID_BATCH_MESSAGE' });
    fixture.expectNoSideEffects();
  });

  it.each(['analysis-jobs/aj_owned/batches/1.json', 'analysis-jobs/aj_owned/batches/../1.json.gz'])('rejects a noncanonical stored key or encoding %s', async (payloadObjectKey) => {
    const fixture = createIsolationFixture();
    fixture.repository.getBatch.mockResolvedValue({ ...fixture.batch, payloadObjectKey });
    await expect(fixture.processor.process({ ...fixture.message, payloadObjectKey }, 1)).rejects.toMatchObject({ code: 'INVALID_BATCH_MESSAGE' });
    fixture.expectNoSideEffects();
  });

  it('does not write failure bookkeeping when the manifest lookup fails', async () => {
    const fixture = createIsolationFixture();
    fixture.repository.getBatch.mockRejectedValue(new Error('database unavailable'));
    await expect(fixture.processor.process(fixture.message, 1)).rejects.toThrow('database unavailable');
    fixture.expectNoSideEffects();
  });

  it.each([
    { jobId: 'aj_other' }, { batchIndex: 2 }, { memoryCount: 2 }, { memories: [] }, { memories: null },
  ])('rejects a mismatched S3 payload manifest %p before classification', async (override) => {
    const fixture = createIsolationFixture();
    fixture.storage.getObjectBuffer.mockResolvedValue(gzipJson({ ...fixture.payload, ...override }));
    await expect(fixture.processor.process(fixture.message, 1)).rejects.toMatchObject({ code: 'INVALID_BATCH_PAYLOAD' });
    expect(fixture.storage.getObjectBuffer).toHaveBeenCalledWith(fixture.batch.payloadObjectKey);
    expect(fixture.repository.markBatchFailure).toHaveBeenCalledWith(expect.objectContaining({
      jobId: fixture.message.jobId, batchIndex: 1, errorCode: 'INVALID_BATCH_PAYLOAD',
    }));
    expect(fixture.repository.markBatchSucceeded).not.toHaveBeenCalled();
    expect(fixture.taxonomyCache.getRules).not.toHaveBeenCalled();
    expect(fixture.redis.multi).not.toHaveBeenCalled();
  });

  it('rejects modified S3 contents even when the message hash matches the stored manifest', async () => {
    const fixture = createIsolationFixture();
    fixture.storage.getObjectBuffer.mockResolvedValue(gzipJson({
      ...fixture.payload, memories: [{ ...fixture.payload.memories[0], content: 'substituted content' }],
    }));
    await expect(fixture.processor.process(fixture.message, 1)).rejects.toMatchObject({ code: 'PAYLOAD_HASH_VALIDATION_FAILED' });
    expect(fixture.repository.markBatchSucceeded).not.toHaveBeenCalled();
    expect(fixture.taxonomyCache.getRules).not.toHaveBeenCalled();
    expect(fixture.redis.multi).not.toHaveBeenCalled();
  });

  it('rejects plaintext JSON stored at the gzip key without classifying it', async () => {
    const fixture = createIsolationFixture();
    fixture.storage.getObjectBuffer.mockResolvedValue(Buffer.from(JSON.stringify(fixture.payload)));
    await expect(fixture.processor.process(fixture.message, 1)).rejects.toThrow();
    expect(fixture.repository.markBatchFailure).toHaveBeenCalledWith(expect.objectContaining({ jobId: fixture.message.jobId }));
    expect(fixture.repository.markBatchSucceeded).not.toHaveBeenCalled();
    expect(fixture.taxonomyCache.getRules).not.toHaveBeenCalled();
  });
});
