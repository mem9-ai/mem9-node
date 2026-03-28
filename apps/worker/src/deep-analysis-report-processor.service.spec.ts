import { gzipJson } from '@mem9/shared';

import { DeepAnalysisReportProcessorService } from './deep-analysis-report-processor.service';

describe('deep analysis report processor service', () => {
  it('builds a completed report with cleaned themes, entities, duplicate counts, and usage audit', async () => {
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_1',
        status: 'QUEUED',
        lang: 'zh-CN',
        sourceSnapshotObjectKey: 'deep-analysis/reports/dar_1/source.json.gz',
        internalComment: null,
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
      getConfiguredModel: jest.fn(() => 'qwen3.5-pro'),
      createJson: jest
        .fn()
        .mockImplementationOnce(async () => ({
          parsed: {
            summary: 'Alice and Bosn repeatedly align on dashboard roadmap execution.',
            themes: [{ name: 'dashboard roadmap', memoryIds: ['mem_1', 'mem_3'] }],
            entities: {
              people: ['Alice Johnson', 'Bosn'],
              teams: ['Platform Team'],
              projects: ['dashboard roadmap'],
              tools: ['React'],
              places: [],
            },
            personaSignals: {
              workingStyle: ['Prefers structured reviews and staged rollout decisions.'],
              goals: ['Keep memory insight workflows durable.'],
              preferences: ['Concise but information-dense summaries.'],
              constraints: ['Do not delete canonical memories.'],
              decisionSignals: ['Balances speed and correctness in dashboard work.'],
              notableRoutines: ['Reviews traffic dashboards every morning.'],
              contradictionsOrTensions: ['Wants concise output without losing implementation detail.'],
            },
            relationships: [],
          },
          usage: {
            model: 'qwen3.5-pro',
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150,
            usageMissing: false,
          },
          requestMeta: {
            stage: 'chunk_analysis',
            success: true,
            requested: true,
            httpStatus: 200,
            parseSucceeded: true,
            errorCode: null,
            errorMessage: null,
            requestedAt: '2026-03-28T00:00:00.000Z',
            finishedAt: '2026-03-28T00:00:01.000Z',
          },
        }))
        .mockImplementationOnce(async () => ({
          parsed: null,
          usage: {
            model: 'qwen3.5-pro',
            promptTokens: 90,
            completionTokens: 20,
            totalTokens: 110,
            usageMissing: false,
          },
          requestMeta: {
            stage: 'global_synthesis',
            success: false,
            requested: true,
            httpStatus: 200,
            parseSucceeded: false,
            errorCode: 'QWEN_JSON_PARSE_FAILED',
            errorMessage: 'Unexpected token',
            requestedAt: '2026-03-28T00:00:02.000Z',
            finishedAt: '2026-03-28T00:00:03.000Z',
          },
        })),
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
      discoveries: Array<{ title: string; kind: string }>;
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
    expect(report.discoveries.length).toBeGreaterThan(0);
    expect(report.discoveries.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["focus_area", "hygiene"]),
    );
    expect(report.themeLandscape.highlights.map((item) => item.name)).not.toEqual(
      expect.arrayContaining(['the', 'for', 'user', 'team']),
    );
    expect(report.entities.people.map((item) => item.label)).toEqual(
      expect.arrayContaining(['Alice Johnson', 'Bosn']),
    );
    expect(report.entities.teams.map((item) => item.label)).not.toEqual(
      expect.arrayContaining(['team', 'Platform']),
    );

    const internalCommentUpdates = (
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<[string, { internalComment?: string }]>
    )
      .map((call) => call[1]?.internalComment)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value) as {
        aggregate: {
          requestCount: number;
          successCount: number;
          failureCount: number;
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
        };
        calls: Array<{
          stage: string;
          index: number;
          success: boolean;
        }>;
      });
    const firstUsageUpdate = internalCommentUpdates.find(
      (payload) => payload.aggregate.requestCount === 1,
    );
    expect(firstUsageUpdate).toBeTruthy();
    const internalComment = firstUsageUpdate as {
      aggregate: {
        requestCount: number;
        successCount: number;
        failureCount: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
    };
    expect(internalComment.aggregate).toEqual({
      requestCount: 1,
      successCount: 1,
      failureCount: 0,
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
    });

    expect(repository.updateDeepAnalysisReport).toHaveBeenLastCalledWith(
      'dar_1',
      expect.objectContaining({
        status: 'COMPLETED',
        stage: 'COMPLETE',
        progressPercent: 100,
        reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
        internalComment: expect.any(String),
        previewJson: expect.objectContaining({
          summary: expect.any(String),
        }),
      }),
    );

    const finalCall = (
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<[string, { internalComment?: string }]>
    ).at(-1);
    const finalPayload = finalCall?.[1];
    expect(finalPayload?.internalComment).toBeTruthy();
    const finalInternalComment = JSON.parse(String(finalPayload?.internalComment)) as {
      aggregate: {
        requestCount: number;
        successCount: number;
        failureCount: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
      calls: Array<{
        stage: string;
        index: number;
        success: boolean;
        httpStatus: number | null;
      }>;
    };
    expect(finalInternalComment.aggregate).toEqual({
      requestCount: 2,
      successCount: 1,
      failureCount: 1,
      promptTokens: 210,
      completionTokens: 50,
      totalTokens: 260,
    });
    expect(finalInternalComment.calls).toEqual([
      expect.objectContaining({
        stage: 'chunk_analysis',
        index: 1,
        success: true,
        httpStatus: 200,
      }),
      expect.objectContaining({
        stage: 'global_synthesis',
        index: 1,
        success: false,
        httpStatus: 200,
      }),
    ]);
  });
});
