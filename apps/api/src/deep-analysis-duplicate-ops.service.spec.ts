import { gzipJson } from '@mem9/shared';
import { Logger } from '@nestjs/common';

import { DeepAnalysisDuplicateOpsService } from './deep-analysis-duplicate-ops.service';

function createContext() {
  return {
    apiKeyFingerprint: Buffer.alloc(32, 7),
    apiKeyFingerprintHex: Buffer.alloc(32, 7).toString('hex'),
    rawApiKey: 'space-key',
    requestId: 'req_1',
  };
}

describe('deep analysis duplicate ops service', () => {
  it('rejects a historical model-generated cluster whose contents are different before deleting anything', async () => {
    const report = {
      id: 'dar_1', status: 'COMPLETED', reportObjectKey: 'report.json',
      sourceSnapshotObjectKey: 'source.json.gz',
    };
    const source = {
      deleteMemories: jest.fn().mockResolvedValue({ deletedMemoryIds: ['mem_2'], failedMemoryIds: [] }),
      fetchMemoryById: jest.fn(),
    };
    const service = new DeepAnalysisDuplicateOpsService({
      getOwnedDeepAnalysisReport: jest.fn().mockResolvedValue(report),
      getDeepAnalysisReport: jest.fn().mockResolvedValue(report),
      updateDeepAnalysisReport: jest.fn(),
    } as never, source as never, {
      getObjectBuffer: jest.fn(async (key: string) => key === 'report.json'
        ? Buffer.from(JSON.stringify({ quality: { duplicateClusters: [
          { canonicalMemoryId: 'mem_1', duplicateMemoryIds: ['mem_2'] },
        ] } }))
        : gzipJson({ memories: [
          { id: 'mem_1', content: 'Keep the project.' },
          { id: 'mem_2', content: 'Cancel the project.' },
        ] })),
    } as never);

    const result: unknown = await service.deleteDuplicateMemories(createContext(), 'dar_1').catch((error: unknown) => error);
    await new Promise(resolve => setImmediate(resolve));
    expect(source.deleteMemories).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: 'DEEP_ANALYSIS_DUPLICATES_UNVERIFIED' });
  });

  it('exports duplicate cleanup CSV without including canonical ids as deletions', async () => {
    const service = new DeepAnalysisDuplicateOpsService(
      {
        getOwnedDeepAnalysisReport: jest.fn(async () => ({
          id: 'dar_1',
          status: 'COMPLETED',
          reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
          sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
        })),
      } as never,
      {
        deleteMemories: jest.fn(),
      } as never,
      {
        getObjectBuffer: jest
          .fn()
          .mockResolvedValueOnce(Buffer.from(JSON.stringify({
            quality: {
              duplicateClusters: [
                {
                  canonicalMemoryId: 'mem_1',
                  duplicateMemoryIds: ['mem_2', 'mem_3'],
                },
              ],
            },
          })))
          .mockResolvedValueOnce(gzipJson({
            fetchedAt: '2026-03-28T00:00:00Z',
            memoryCount: 3,
            memories: [
              { id: 'mem_1', content: 'Canonical memory' },
              { id: 'mem_2', content: 'Canonical memory' },
              { id: 'mem_3', content: 'Canonical memory' },
            ],
          })),
      } as never,
    );

    const result = await service.downloadDuplicateCleanupCsv(createContext(), 'dar_1');

    expect(result.filename).toBe('deep-analysis-dar_1-duplicate-cleanup.csv');
    expect(result.content).toContain('duplicateMemoryId');
    expect(result.content).toContain('mem_2');
    expect(result.content).toContain('mem_3');
    expect(result.content).not.toContain('"mem_1",');
  });

  it('delegates duplicate deletion to the mem9 source client', async () => {
    const auditLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    let resolveDeletionStarted!: () => void;
    const deletionStarted = new Promise<void>((resolve) => {
      resolveDeletionStarted = resolve;
    });
    const source = {
      fetchMemoryById: jest.fn(async (_key: string, id: string) => ({ id, content: 'Canonical memory' })),
      deleteMemories: jest.fn(async () => {
        resolveDeletionStarted();
        return {
          deletedMemoryIds: ['mem_2'],
          failedMemoryIds: ['mem_3'],
        };
      }),
    };
    const service = new DeepAnalysisDuplicateOpsService(
      {
        getOwnedDeepAnalysisReport: jest.fn(async () => ({
          id: 'dar_1',
          status: 'COMPLETED',
          reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
          sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
          requestedAt: new Date('2026-03-28T00:00:00Z'),
          completedAt: new Date('2026-03-28T00:05:00Z'),
          previewJson: {
            generatedAt: '2026-03-28T00:05:00Z',
            summary: 'Engineering-heavy corpus.',
            topThemes: ['engineering'],
            keyRecommendations: ['Deduplicate repeated notes'],
          },
        })),
        getDeepAnalysisReport: jest.fn(async () => ({
          id: 'dar_1',
          status: 'COMPLETED',
          reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
          sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
          requestedAt: new Date('2026-03-28T00:00:00Z'),
          completedAt: new Date('2026-03-28T00:05:00Z'),
          previewJson: {
            generatedAt: '2026-03-28T00:05:00Z',
            summary: 'Engineering-heavy corpus.',
            topThemes: ['engineering'],
            keyRecommendations: ['Deduplicate repeated notes'],
          },
        })),
        updateDeepAnalysisReport: jest.fn(async () => undefined),
      } as never,
      source as never,
      {
        getObjectBuffer: jest.fn(async (key: string) => key.endsWith('source.json.gz')
          ? gzipJson({ memories: [
            { id: 'mem_1', content: 'Canonical memory' },
            { id: 'mem_2', content: 'Canonical memory' },
            { id: 'mem_3', content: 'Canonical memory' },
          ] })
          : Buffer.from(JSON.stringify({
          quality: {
            duplicateClusters: [
              {
                canonicalMemoryId: 'mem_1',
                duplicateMemoryIds: ['mem_2', 'mem_3'],
              },
            ],
          },
        }))),
      } as never,
    );

    const result = await service.deleteDuplicateMemories(createContext(), 'dar_1');
    await deletionStarted;

    expect(result.duplicateCleanup.status).toBe('QUEUED');
    expect(result.duplicateCleanup.totalCount).toBe(2);
    expect(source.deleteMemories).toHaveBeenCalledWith('space-key', ['mem_2', 'mem_3']);
    await new Promise(resolve => setImmediate(resolve));
    const events = auditLog.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'duplicate_cleanup_started', requestId: 'req_1', reportId: 'dar_1', requestedCount: 2 }),
      expect.objectContaining({ event: 'duplicate_cleanup_result', deletedCount: 1, failedCount: 1 }),
    ]));
    expect(JSON.stringify(events)).not.toContain('space-key');
    auditLog.mockRestore();
  });

  it('rejects deleting a running report', async () => {
    const service = new DeepAnalysisDuplicateOpsService(
      {
        getOwnedDeepAnalysisReport: jest.fn(async () => ({
          id: 'dar_1',
          status: 'PREPARING',
          reportObjectKey: null,
          sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
        })),
      } as never,
      {
        deleteMemories: jest.fn(),
      } as never,
      {
        deleteObject: jest.fn(),
      } as never,
    );

    await expect(
      service.deleteReport(createContext(), 'dar_1'),
    ).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_REPORT_RUNNING',
    });
  });

  it('rejects deleting a report while duplicate cleanup is running', async () => {
    const now = new Date();
    const service = new DeepAnalysisDuplicateOpsService(
      {
        getOwnedDeepAnalysisReport: jest.fn(async () => ({
          id: 'dar_1',
          status: 'COMPLETED',
          reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
          sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
          previewJson: {
            generatedAt: '2026-03-28T00:05:00Z',
            summary: 'Engineering-heavy corpus.',
            topThemes: ['engineering'],
            keyRecommendations: ['Deduplicate repeated notes'],
            duplicateCleanup: {
              status: 'RUNNING',
              requestedAt: new Date(now.getTime() - 1000).toISOString(),
              startedAt: now.toISOString(),
              completedAt: null,
              totalCount: 2,
              deletedCount: 0,
              failedCount: 0,
              deletedMemoryIds: [],
              failedMemoryIds: [],
              errorMessage: null,
            },
          },
        })),
      } as never,
      {
        deleteMemories: jest.fn(),
      } as never,
      {
        deleteObject: jest.fn(),
      } as never,
    );

    await expect(
      service.deleteReport(createContext(), 'dar_1'),
    ).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_DUPLICATE_CLEANUP_RUNNING',
    });
  });
});

describe('duplicate cleanup verification boundaries', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  function setup(clusters: unknown = [{ canonicalMemoryId: 'keep', duplicateMemoryIds: ['copy', 'copy2'] }]) {
    const memories = [
      { id: 'keep', content: 'Important decision' },
      { id: 'copy', content: ' IMPORTANT  decision\n' },
      { id: 'copy2', content: 'Important decision' },
      { id: 'different', content: 'Unrelated decision' },
    ];
    const report = {
      id: 'report', status: 'COMPLETED', reportObjectKey: 'report.json',
      sourceSnapshotObjectKey: 'source.json.gz', previewJson: {} as Record<string, unknown>,
    };
    const repository = {
      getOwnedDeepAnalysisReport: jest.fn(async () => ({ ...report })),
      getDeepAnalysisReport: jest.fn(async () => ({ ...report })),
      updateDeepAnalysisReport: jest.fn(async (_id: string, update: { previewJson: Record<string, unknown> }) => {
        report.previewJson = update.previewJson;
      }),
    };
    const source = {
      fetchMemoryById: jest.fn(async (_key: string, id: string) => ({ ...memories.find(memory => memory.id === id)! })),
      deleteMemories: jest.fn(async (_key: string, ids: string[]) => ({ deletedMemoryIds: ids, failedMemoryIds: [] as string[] })),
    };
    const storage = {
      getObjectBuffer: jest.fn(async (key: string) => key === 'report.json'
        ? Buffer.from(JSON.stringify({ quality: { duplicateClusters: clusters } }))
        : gzipJson({ memories })),
    };
    return {
      service: new DeepAnalysisDuplicateOpsService(repository as never, source as never, storage as never),
      report, repository, source, storage, memories,
    };
  }

  it.each([
    ['different content', [{ canonicalMemoryId: 'keep', duplicateMemoryIds: ['different'] }]],
    ['unknown duplicate', [{ canonicalMemoryId: 'keep', duplicateMemoryIds: ['missing'] }]],
    ['unknown canonical', [{ canonicalMemoryId: 'missing', duplicateMemoryIds: ['copy'] }]],
    ['self deletion', [{ canonicalMemoryId: 'keep', duplicateMemoryIds: ['keep'] }]],
    ['cyclic clusters', [
      { canonicalMemoryId: 'keep', duplicateMemoryIds: ['copy'] },
      { canonicalMemoryId: 'copy', duplicateMemoryIds: ['keep'] },
    ]],
    ['malformed cluster', [null]],
    ['malformed duplicate list', [{ canonicalMemoryId: 'keep', duplicateMemoryIds: 'copy' }]],
    ['missing cluster list', null],
  ])('rejects %s in historical reports and CSV exports', async (_label, clusters) => {
    const f = setup(clusters);
    await expect(f.service.deleteDuplicateMemories(createContext(), 'report')).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_DUPLICATES_UNVERIFIED',
    });
    await expect(f.service.downloadDuplicateCleanupCsv(createContext(), 'report')).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_DUPLICATES_UNVERIFIED',
    });
    expect(f.repository.updateDeepAnalysisReport).not.toHaveBeenCalled();
    expect(f.source.fetchMemoryById).not.toHaveBeenCalled();
    expect(f.source.deleteMemories).not.toHaveBeenCalled();
  });

  it.each(['keep', 'copy2'])('checks current contents of %s before any DELETE', async (changedId) => {
    const f = setup();
    f.source.fetchMemoryById.mockImplementation(async (_key, id) => ({
      id, content: id === changedId ? 'Changed after the snapshot' : 'Important decision',
    }));
    await f.service.deleteDuplicateMemories(createContext(), 'report');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.source.deleteMemories).not.toHaveBeenCalled();
    expect(f.report.previewJson.duplicateCleanup).toMatchObject({ status: 'FAILED', deletedCount: 0, failedCount: 2 });
  });

  it.each(['not found', 'upstream unavailable', 'access denied'])('fails closed when live verification fails: %s', async (reason) => {
    const f = setup();
    f.source.fetchMemoryById.mockRejectedValue(new Error(reason));
    await f.service.deleteDuplicateMemories(createContext(), 'report');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.source.deleteMemories).not.toHaveBeenCalled();
    expect(f.report.previewJson.duplicateCleanup).toMatchObject({ status: 'FAILED', deletedCount: 0 });
  });

  it('rejects a live response for a different memory even when its content matches', async () => {
    const f = setup();
    f.source.fetchMemoryById.mockResolvedValue({ id: 'wrong', content: 'Important decision' });
    await f.service.deleteDuplicateMemories(createContext(), 'report');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.source.deleteMemories).not.toHaveBeenCalled();
    expect(f.report.previewJson.duplicateCleanup).toMatchObject({ status: 'FAILED' });
  });

  it('verifies the whole batch before deletion and preserves the canonical on retries', async () => {
    const f = setup();
    f.report.previewJson.duplicateCleanup = { status: 'FAILED', deletedMemoryIds: ['copy'] };
    const result = await f.service.deleteDuplicateMemories(createContext(), 'report');
    await new Promise(resolve => setImmediate(resolve));
    expect(result.duplicateCleanup.totalCount).toBe(1);
    expect(f.source.fetchMemoryById.mock.calls).toEqual([['space-key', 'keep'], ['space-key', 'copy2']]);
    expect(f.source.deleteMemories).toHaveBeenCalledWith('space-key', ['copy2']);
    expect(Math.max(...f.source.fetchMemoryById.mock.invocationCallOrder))
      .toBeLessThan(f.source.deleteMemories.mock.invocationCallOrder[0]!);
    expect(f.report.previewJson.duplicateCleanup).toMatchObject({
      status: 'COMPLETED', deletedMemoryIds: ['copy', 'copy2'], failedCount: 0,
    });
    await f.service.deleteDuplicateMemories(createContext(), 'report');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.source.deleteMemories).toHaveBeenCalledTimes(1);
  });

  it('does not replay an active cleanup', async () => {
    const f = setup();
    f.report.previewJson.duplicateCleanup = {
      status: 'RUNNING', requestedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    };
    await f.service.deleteDuplicateMemories(createContext(), 'report');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.repository.updateDeepAnalysisReport).not.toHaveBeenCalled();
    expect(f.source.deleteMemories).not.toHaveBeenCalled();
  });

  it('bounds live verification concurrency and completes every read before deletion', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `copy_${index}`);
    const f = setup([{ canonicalMemoryId: 'keep', duplicateMemoryIds: ids }]);
    f.memories.push(...ids.map(id => ({ id, content: 'Important decision' })));
    let active = 0;
    let peak = 0;
    f.source.fetchMemoryById.mockImplementation(async (_key, id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return { id, content: 'Important decision' };
    });
    let finished!: () => void;
    const completion = new Promise<void>(resolve => { finished = resolve; });
    f.repository.updateDeepAnalysisReport.mockImplementation(async (_id, update) => {
      f.report.previewJson = update.previewJson;
      if ((update.previewJson.duplicateCleanup as { status: string }).status === 'COMPLETED') finished();
    });
    await f.service.deleteDuplicateMemories(createContext(), 'report');
    await completion;
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(f.source.fetchMemoryById).toHaveBeenCalledTimes(11);
    expect(f.source.deleteMemories).toHaveBeenCalledWith('space-key', ids);
    expect(Math.max(...f.source.fetchMemoryById.mock.invocationCallOrder))
      .toBeLessThan(f.source.deleteMemories.mock.invocationCallOrder[0]!);
  });

  it('fails closed when the source snapshot is unavailable', async () => {
    const f = setup();
    f.storage.getObjectBuffer.mockResolvedValueOnce(Buffer.from(JSON.stringify({ quality: {
      duplicateClusters: [{ canonicalMemoryId: 'keep', duplicateMemoryIds: ['copy'] }],
    } }))).mockRejectedValueOnce(new Error('Source unavailable'));
    await expect(f.service.deleteDuplicateMemories(createContext(), 'report')).rejects.toThrow();
    expect(f.source.deleteMemories).not.toHaveBeenCalled();
    expect(f.repository.updateDeepAnalysisReport).not.toHaveBeenCalled();
  });

  it('rejects ambiguous snapshot IDs', async () => {
    const f = setup();
    f.memories.push({ id: 'copy', content: 'Another content for the same id' });
    await expect(f.service.deleteDuplicateMemories(createContext(), 'report')).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_DUPLICATES_UNVERIFIED',
    });
    expect(f.source.deleteMemories).not.toHaveBeenCalled();
  });
});
