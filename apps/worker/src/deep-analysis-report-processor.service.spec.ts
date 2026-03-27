import { gzipJson } from '@mem9/shared';

import { DeepAnalysisReportProcessorService } from './deep-analysis-report-processor.service';

describe('deep analysis report processor service', () => {
  it('builds a completed report using original counts and duplicate clusters', async () => {
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_1',
        status: 'QUEUED',
        lang: 'zh-CN',
        sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
      })),
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () => gzipJson({
        fetchedAt: '2026-03-28T00:00:00Z',
        memoryCount: 3,
        memories: [
          {
            id: 'mem_1',
            content: 'Prefer React and work with Alice Johnson',
            createdAt: '2026-03-20T00:00:00Z',
            updatedAt: '2026-03-20T00:00:00Z',
            memoryType: 'insight',
            tags: ['dashboard'],
            metadata: null,
          },
          {
            id: 'mem_2',
            content: 'Prefer React and work with Alice Johnson',
            createdAt: '2026-03-21T00:00:00Z',
            updatedAt: '2026-03-21T00:00:00Z',
            memoryType: 'insight',
            tags: ['dashboard'],
            metadata: null,
          },
          {
            id: 'mem_3',
            content: 'Daily plan for the platform team using TypeScript',
            createdAt: '2026-03-22T00:00:00Z',
            updatedAt: '2026-03-22T00:00:00Z',
            memoryType: 'insight',
            tags: ['platform'],
            metadata: null,
          },
        ],
      })),
      putJson: jest.fn(async () => undefined),
    };
    const qwen = {
      createJson: jest.fn(async () => null),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
    );

    await processor.process({
      messageType: 'deep_report',
      reportId: 'dar_1',
      traceId: 'trace_1',
    });

    expect(storage.putJson).toHaveBeenCalledTimes(1);
    const [, report] = storage.putJson.mock.calls[0] as unknown as [string, {
      overview: {
        memoryCount: number;
        deduplicatedMemoryCount: number;
      };
      quality: {
        duplicateRatio: number;
        duplicateClusters: Array<{
          canonicalMemoryId: string;
          duplicateMemoryIds: string[];
        }>;
      };
    }];
    expect(report).toMatchObject({
      overview: {
        memoryCount: 3,
        deduplicatedMemoryCount: 2,
      },
      quality: {
        duplicateClusters: [
          {
            canonicalMemoryId: 'mem_1',
            duplicateMemoryIds: ['mem_2'],
          },
        ],
      },
    });
    expect(report.quality.duplicateRatio).toBe(0.33);

    expect(repository.updateDeepAnalysisReport).toHaveBeenLastCalledWith(
      'dar_1',
      expect.objectContaining({
        status: 'COMPLETED',
        stage: 'COMPLETE',
        progressPercent: 100,
        reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
        previewJson: expect.objectContaining({
          summary: expect.any(String),
        }),
      }),
    );
  });
});
