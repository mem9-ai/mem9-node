import { gunzipJson } from '@mem9/shared';

import { DeepAnalysisSourcePreparationService } from './deep-analysis-source-preparation.service';

describe('deep analysis source preparation service', () => {
  it('uploads the source snapshot and enqueues the deep-report job', async () => {
    const repository = {
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const source = {
      fetchAllMemories: jest.fn(async () => [
        {
          id: 'mem_1',
          content: 'Memory 1',
          createdAt: '2026-03-20T00:00:00Z',
          updatedAt: '2026-03-20T00:00:00Z',
          memoryType: 'insight',
          tags: [],
          metadata: null,
        },
      ]),
    };
    const storage = {
      putCompressedJson: jest.fn(async () => undefined),
    };
    const queue = {
      enqueueLlmMessage: jest.fn(async () => undefined),
    };
    const service = new DeepAnalysisSourcePreparationService(
      repository as never,
      source as never,
      storage as never,
      queue as never,
    );

    await service.prepareAndEnqueue({
      reportId: 'dar_1',
      sourceSnapshotObjectKey: 'deep-analysis/reports/snapshot_1/source.json.gz',
      rawApiKey: 'space-key',
      traceId: 'req_1',
    });

    expect(repository.updateDeepAnalysisReport).toHaveBeenNthCalledWith(
      1,
      'dar_1',
      expect.objectContaining({
        status: 'PREPARING',
        stage: 'FETCH_SOURCE',
        progressPercent: 5,
      }),
    );
    const [, payload] = storage.putCompressedJson.mock.calls[0] as unknown as [string, Buffer];
    const snapshot = gunzipJson<{ memoryCount: number; memories: Array<{ id: string }> }>(payload);
    expect(snapshot.memoryCount).toBe(1);
    expect(snapshot.memories[0]?.id).toBe('mem_1');
    expect(queue.enqueueLlmMessage).toHaveBeenCalledWith({
      messageType: 'deep_report',
      reportId: 'dar_1',
      traceId: 'req_1',
    });
  });

  it('marks the report failed when source fetch throws', async () => {
    const repository = {
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const service = new DeepAnalysisSourcePreparationService(
      repository as never,
      {
        fetchAllMemories: jest.fn(async () => {
          throw new Error('upstream timeout');
        }),
      } as never,
      {
        putCompressedJson: jest.fn(),
      } as never,
      {
        enqueueLlmMessage: jest.fn(),
      } as never,
    );

    await service.prepareAndEnqueue({
      reportId: 'dar_1',
      sourceSnapshotObjectKey: 'deep-analysis/reports/snapshot_1/source.json.gz',
      rawApiKey: 'space-key',
      traceId: 'req_1',
    });

    expect(repository.updateDeepAnalysisReport).toHaveBeenLastCalledWith(
      'dar_1',
      expect.objectContaining({
        status: 'FAILED',
        stage: 'FETCH_SOURCE',
        errorCode: 'DEEP_ANALYSIS_SOURCE_PREP_FAILED',
      }),
    );
  });
});
