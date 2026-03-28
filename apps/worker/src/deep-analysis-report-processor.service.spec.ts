import { gzipJson } from '@mem9/shared';

import { DeepAnalysisReportProcessorService } from './deep-analysis-report-processor.service';

describe('deep analysis report processor service', () => {
  it('builds a completed report with cleaned themes, entities, and duplicate counts', async () => {
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
        memoryCount: 4,
        memories: [
          {
            id: 'mem_1',
            content: 'Prefer structured memory capture and work with Alice Johnson on the dashboard roadmap.',
            createdAt: '2026-03-20T00:00:00Z',
            updatedAt: '2026-03-20T00:00:00Z',
            memoryType: 'insight',
            tags: ['dashboard-roadmap'],
            metadata: null,
          },
          {
            id: 'mem_2',
            content: 'Prefer structured memory capture and work with Alice Johnson on the dashboard roadmap.',
            createdAt: '2026-03-21T00:00:00Z',
            updatedAt: '2026-03-21T00:00:00Z',
            memoryType: 'insight',
            tags: ['dashboard-roadmap'],
            metadata: null,
          },
          {
            id: 'mem_3',
            content: 'Every morning Bosn reviews traffic dashboards and prioritizes concise but detailed summaries for the Platform Team.',
            createdAt: '2026-03-22T00:00:00Z',
            updatedAt: '2026-03-22T00:00:00Z',
            memoryType: 'insight',
            tags: ['traffic-ops'],
            metadata: null,
          },
          {
            id: 'mem_4',
            content: 'Need to automate duplicate cleanup for memory analysis while keeping canonical entries stable.',
            createdAt: '2026-03-23T00:00:00Z',
            updatedAt: '2026-03-23T00:00:00Z',
            memoryType: 'insight',
            tags: ['memory-analysis'],
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
      persona: {
        summary: string;
        workingStyle: string[];
        notableRoutines: string[];
        contradictionsOrTensions: string[];
        evidenceHighlights: Array<{ memoryIds: string[] }>;
      };
      themeLandscape: {
        highlights: Array<{ name: string }>;
      };
      entities: {
        people: Array<{ label: string }>;
        teams: Array<{ label: string }>;
      };
      quality: {
        duplicateRatio: number;
        duplicateMemoryCount: number;
        duplicateClusters: Array<{
          canonicalMemoryId: string;
          duplicateMemoryIds: string[];
        }>;
      };
    }];

    expect(report).toMatchObject({
      overview: {
        memoryCount: 4,
        deduplicatedMemoryCount: 3,
      },
      quality: {
        duplicateMemoryCount: 1,
        duplicateClusters: [
          {
            canonicalMemoryId: 'mem_1',
            duplicateMemoryIds: ['mem_2'],
          },
        ],
      },
    });
    expect(report.quality.duplicateRatio).toBe(0.25);
    expect(report.persona.summary.length).toBeGreaterThan(80);
    expect(report.persona.workingStyle.length).toBeGreaterThan(0);
    expect(report.persona.notableRoutines.length).toBeGreaterThan(0);
    expect(report.persona.evidenceHighlights[0]?.memoryIds?.[0]).toBeTruthy();
    expect(report.themeLandscape.highlights.map((item) => item.name)).not.toEqual(
      expect.arrayContaining(['the', 'for', 'user', 'team']),
    );
    expect(report.entities.people.map((item) => item.label)).toEqual(
      expect.arrayContaining(['Alice Johnson', 'Bosn']),
    );
    expect(report.entities.teams.map((item) => item.label)).not.toEqual(
      expect.arrayContaining(['team', 'Platform']),
    );

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
