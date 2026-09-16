import { AnalysisJobsService, buildFacetStats } from './analysis-jobs.service';

describe('analysis jobs service', () => {
  it('exposes the service symbol for integration wiring', () => {
    expect(AnalysisJobsService).toBeDefined();
  });

  it('builds stable facet stats sorted by count desc then value asc and capped at 50', () => {
    const counts: Record<string, number> = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`term-${index.toString().padStart(2, '0')}`, 1] as const),
    );

    counts.priority = 53;
    counts.beta = 5;
    counts.alpha = 5;

    const stats = buildFacetStats(counts);

    expect(stats).toHaveLength(50);
    expect(stats[0]).toEqual({ value: 'priority', count: 53 });
    expect(stats[1]).toEqual({ value: 'alpha', count: 5 });
    expect(stats[2]).toEqual({ value: 'beta', count: 5 });
    expect(stats[3]).toEqual({ value: 'term-00', count: 1 });
    expect(stats[49]).toEqual({ value: 'term-46', count: 1 });
  });

  it('loads source memories on the server and uploads normalized batches', async () => {
    const repository = {
      getOwnedJob: jest.fn(async () => ({ status: 'UPLOADING' })),
      markJobFailed: jest.fn(),
    };
    const source = {
      fetchAllMemories: jest.fn(async () => [
        {
          id: 'mem-1',
          content: 'legitimate content that an edge WAF may reject',
          createdAt: '2026-03-01T00:00:00.000Z',
          metadata: null,
        },
      ]),
    };
    const service = new AnalysisJobsService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      source as never,
      { analysis: { jobResultTtlSeconds: 3600 } } as never,
    );
    jest.spyOn(service, 'createJob').mockResolvedValue({
      jobId: 'aj_source',
      status: 'UPLOADING',
      expectedTotalBatches: 1,
      uploadConcurrency: 3,
      pollAfterMs: 1500,
    });
    const uploadBatch = jest.spyOn(service, 'uploadBatch').mockResolvedValue({
      jobId: 'aj_source',
      batchIndex: 1,
      status: 'QUEUED',
      payloadObjectKey: 'analysis-jobs/aj_source/batches/1.json.gz',
      payloadHash: 'hash',
      queuedAt: '2026-03-01T00:00:00.000Z',
    });
    const finalizeJob = jest.spyOn(service, 'finalizeJob').mockResolvedValue({
      jobId: 'aj_source',
      status: 'PROCESSING',
      uploadedBatches: 1,
      expectedTotalBatches: 1,
    });

    await service.createJobFromSource(
      {
        apiKeyFingerprint: Buffer.alloc(32),
        apiKeyFingerprintHex: '00',
        rawApiKey: 'space-key',
        requestId: 'req-1',
      },
      {
        dateRange: {
          start: '2026-03-01T00:00:00.000Z',
          end: '2026-03-02T00:00:00.000Z',
        },
        expectedTotalMemories: 1,
        expectedTotalBatches: 1,
        batchSize: 100,
        options: {
          lang: 'zh-CN',
          taxonomyVersion: 'v3',
          llmEnabled: true,
          includeItems: true,
          includeSummary: true,
        },
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(source.fetchAllMemories).toHaveBeenCalledWith('space-key');
    expect(uploadBatch).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1' }),
      'aj_source',
      1,
      {
        memoryCount: 1,
        memories: [{
          id: 'mem-1',
          content: 'legitimate content that an edge WAF may reject',
          createdAt: '2026-03-01T00:00:00.000Z',
          metadata: {},
        }],
      },
    );
    expect(finalizeJob).toHaveBeenCalled();
    expect(repository.markJobFailed).not.toHaveBeenCalled();
  });

  it('does not finalize source preparation after the job is cancelled', async () => {
    const repository = {
      getOwnedJob: jest.fn(async () => ({ status: 'CANCELLED' })),
      markJobFailed: jest.fn(async () => ({ status: 'CANCELLED' })),
    };
    const source = {
      fetchAllMemories: jest.fn(async () => [{
        id: 'mem-1',
        content: 'memory',
        createdAt: '2026-03-01T00:00:00.000Z',
        metadata: {},
      }]),
    };
    const service = new AnalysisJobsService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      source as never,
      { analysis: { jobResultTtlSeconds: 3600 } } as never,
    );
    jest.spyOn(service, 'createJob').mockResolvedValue({
      jobId: 'aj_cancelled',
      status: 'UPLOADING',
      expectedTotalBatches: 1,
      uploadConcurrency: 3,
      pollAfterMs: 1500,
    });
    const uploadBatch = jest.spyOn(service, 'uploadBatch');
    const finalizeJob = jest.spyOn(service, 'finalizeJob');

    await service.createJobFromSource(
      {
        apiKeyFingerprint: Buffer.alloc(32),
        apiKeyFingerprintHex: '00',
        rawApiKey: 'space-key',
        requestId: 'req-1',
      },
      {
        dateRange: {
          start: '2026-03-01T00:00:00.000Z',
          end: '2026-03-02T00:00:00.000Z',
        },
        expectedTotalMemories: 1,
        expectedTotalBatches: 1,
        batchSize: 100,
        options: {
          lang: 'zh-CN',
          taxonomyVersion: 'v3',
          llmEnabled: true,
          includeItems: true,
          includeSummary: true,
        },
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(uploadBatch).not.toHaveBeenCalled();
    expect(repository.markJobFailed).not.toHaveBeenCalled();
    expect(finalizeJob).not.toHaveBeenCalled();
  });
});
