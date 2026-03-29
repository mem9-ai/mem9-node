import { gzipJson } from '@mem9/shared';

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
              { id: 'mem_2', content: 'Duplicate memory 2' },
              { id: 'mem_3', content: 'Duplicate memory 3' },
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
    const source = {
      deleteMemories: jest.fn(async () => ({
        deletedMemoryIds: ['mem_2'],
        failedMemoryIds: ['mem_3'],
      })),
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
        getObjectBuffer: jest.fn(async () => Buffer.from(JSON.stringify({
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(result.duplicateCleanup.status).toBe('QUEUED');
    expect(result.duplicateCleanup.totalCount).toBe(2);
    expect(source.deleteMemories).toHaveBeenCalledWith('space-key', ['mem_2', 'mem_3']);
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
