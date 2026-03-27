import { gunzipJson } from '@mem9/shared';

import { DeepAnalysisService } from './deep-analysis.service';

function createContext() {
  const apiKeyFingerprint = Buffer.alloc(32, 7);
  return {
    apiKeyFingerprint,
    apiKeyFingerprintHex: apiKeyFingerprint.toString('hex'),
    rawApiKey: 'space-key',
    requestId: 'req_1',
  };
}

function createService(overrides?: {
  repository?: Record<string, unknown>;
  source?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  queue?: Record<string, unknown>;
}) {
  const repository = {
    findDeepAnalysisReportByDay: jest.fn(async () => null),
    createDeepAnalysisReport: jest.fn(async () => ({
      id: 'dar_1',
      status: 'QUEUED',
      stage: 'FETCH_SOURCE',
      progressPercent: 0,
      requestedAt: new Date('2026-03-28T00:00:00Z'),
      memoryCount: 1001,
    })),
    listOwnedDeepAnalysisReports: jest.fn(async () => ({
      reports: [],
      total: 0,
    })),
    getOwnedDeepAnalysisReport: jest.fn(async () => ({
      id: 'dar_1',
      status: 'COMPLETED',
      stage: 'COMPLETE',
      progressPercent: 100,
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
      memoryCount: 1001,
      requestedAt: new Date('2026-03-28T00:00:00Z'),
      startedAt: new Date('2026-03-28T00:01:00Z'),
      completedAt: new Date('2026-03-28T00:05:00Z'),
      errorCode: null,
      errorMessage: null,
      previewJson: null,
      reportObjectKey: null,
    })),
    ...overrides?.repository,
  };
  const source = {
    countMemories: jest.fn(async () => 1001),
    fetchAllMemories: jest.fn(async () => [
      {
        id: 'mem_1',
        content: 'Prefer React for dashboard work',
        createdAt: '2026-03-20T00:00:00Z',
        updatedAt: '2026-03-20T00:00:00Z',
        memoryType: 'insight',
        tags: ['dashboard'],
        metadata: null,
      },
    ]),
    ...overrides?.source,
  };
  const storage = {
    putCompressedJson: jest.fn(async () => undefined),
    getObjectBuffer: jest.fn(async () => Buffer.from('{}')),
    ...overrides?.storage,
  };
  const queue = {
    enqueueLlmMessage: jest.fn(async () => undefined),
    ...overrides?.queue,
  };

  return {
    repository,
    source,
    storage,
    queue,
    service: new DeepAnalysisService(
      repository as never,
      source as never,
      storage as never,
      queue as never,
    ),
  };
}

describe('deep analysis service', () => {
  it('returns an already-running error when a report exists for the same day', async () => {
    const { service } = createService({
      repository: {
        findDeepAnalysisReportByDay: jest.fn(async () => ({
          id: 'dar_existing',
          status: 'PREPARING',
        })),
      },
    });

    await expect(
      service.createReport(createContext(), {
        lang: 'zh-CN',
        timezone: 'Asia/Shanghai',
      }),
    ).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_ALREADY_RUNNING',
      details: {
        reportId: 'dar_existing',
      },
    });
  });

  it('rejects requests with too few memories', async () => {
    const { service, source, storage, queue } = createService({
      source: {
        countMemories: jest.fn(async () => 999),
      },
    });

    await expect(
      service.createReport(createContext(), {
        lang: 'zh-CN',
        timezone: 'Asia/Shanghai',
      }),
    ).rejects.toMatchObject({
      code: 'DEEP_ANALYSIS_TOO_FEW_MEMORIES',
      details: {
        memoryCount: 999,
        minimum: 1000,
      },
    });

    expect(source.fetchAllMemories).not.toHaveBeenCalled();
    expect(storage.putCompressedJson).not.toHaveBeenCalled();
    expect(queue.enqueueLlmMessage).not.toHaveBeenCalled();
  });

  it('creates a report, uploads the source snapshot, and enqueues the LLM job', async () => {
    const memories = Array.from({ length: 1001 }, (_, index) => ({
      id: `mem_${index + 1}`,
      content: `Memory ${index + 1} about React and Alice`,
      createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      updatedAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      memoryType: 'insight',
      tags: ['project-a'],
      metadata: null,
    }));
    const { service, storage, queue } = createService({
      source: {
        countMemories: jest.fn(async () => memories.length),
        fetchAllMemories: jest.fn(async () => memories),
      },
      repository: {
        createDeepAnalysisReport: jest.fn(async (input: {
          memoryCount: number;
          sourceSnapshotObjectKey: string;
        }) => ({
          id: 'dar_created',
          status: 'QUEUED',
          stage: 'FETCH_SOURCE',
          progressPercent: 0,
          requestedAt: new Date('2026-03-28T00:00:00Z'),
          memoryCount: input.memoryCount,
          sourceSnapshotObjectKey: input.sourceSnapshotObjectKey,
        })),
      },
    });

    const response = await service.createReport(createContext(), {
      lang: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });

    expect(response).toMatchObject({
      reportId: 'dar_created',
      status: 'QUEUED',
      stage: 'FETCH_SOURCE',
      progressPercent: 0,
      memoryCount: memories.length,
    });
    expect(storage.putCompressedJson).toHaveBeenCalledTimes(1);
    const [objectKey, payload] = storage.putCompressedJson.mock.calls[0] as unknown as [string, Buffer];
    expect(String(objectKey)).toMatch(/^deep-analysis\/reports\/snapshot_/);
    const snapshot = gunzipJson<{ memoryCount: number; memories: Array<{ id: string }> }>(payload as Buffer);
    expect(snapshot.memoryCount).toBe(memories.length);
    expect(snapshot.memories).toHaveLength(memories.length);
    expect(queue.enqueueLlmMessage).toHaveBeenCalledWith({
      messageType: 'deep_report',
      reportId: 'dar_created',
      traceId: 'req_1',
    });
  });

  it('lists reports and loads report details from storage', async () => {
    const reportDocument = {
      overview: {
        memoryCount: 1001,
        deduplicatedMemoryCount: 900,
        generatedAt: '2026-03-28T00:05:00Z',
        lang: 'zh-CN',
        timeSpan: {
          start: '2026-03-01T00:00:00Z',
          end: '2026-03-28T00:00:00Z',
        },
      },
      persona: {
        summary: 'The user prefers structured engineering workflows.',
        preferences: [],
        habits: [],
        goals: [],
        constraints: [],
      },
      themeLandscape: {
        highlights: [],
      },
      entities: {
        people: [],
        teams: [],
        projects: [],
        tools: [],
        places: [],
      },
      relationships: [],
      quality: {
        duplicateRatio: 0.1,
        noisyMemoryCount: 5,
        duplicateClusters: [],
        lowQualityExamples: [],
        coverageGaps: [],
      },
      recommendations: [],
      productSignals: {
        candidateNodes: [],
        candidateEdges: [],
        searchSeeds: [],
      },
    };
    const { service } = createService({
      repository: {
        listOwnedDeepAnalysisReports: jest.fn(async () => ({
          reports: [
            {
              id: 'dar_1',
              status: 'COMPLETED',
              stage: 'COMPLETE',
              progressPercent: 100,
              lang: 'zh-CN',
              timezone: 'Asia/Shanghai',
              memoryCount: 1001,
              requestedAt: new Date('2026-03-28T00:00:00Z'),
              startedAt: new Date('2026-03-28T00:01:00Z'),
              completedAt: new Date('2026-03-28T00:05:00Z'),
              errorCode: null,
              errorMessage: null,
              previewJson: {
                generatedAt: '2026-03-28T00:05:00Z',
                summary: 'Engineering-heavy corpus.',
                topThemes: ['engineering'],
                keyRecommendations: ['Deduplicate repeated notes'],
              },
            },
          ],
          total: 1,
        })),
        getOwnedDeepAnalysisReport: jest.fn(async () => ({
          id: 'dar_1',
          status: 'COMPLETED',
          stage: 'COMPLETE',
          progressPercent: 100,
          lang: 'zh-CN',
          timezone: 'Asia/Shanghai',
          memoryCount: 1001,
          requestedAt: new Date('2026-03-28T00:00:00Z'),
          startedAt: new Date('2026-03-28T00:01:00Z'),
          completedAt: new Date('2026-03-28T00:05:00Z'),
          errorCode: null,
          errorMessage: null,
          previewJson: {
            generatedAt: '2026-03-28T00:05:00Z',
            summary: 'Engineering-heavy corpus.',
            topThemes: ['engineering'],
            keyRecommendations: ['Deduplicate repeated notes'],
          },
          reportObjectKey: 'deep-analysis/reports/dar_1/report.json',
        })),
      },
      storage: {
        getObjectBuffer: jest.fn(async () => Buffer.from(JSON.stringify(reportDocument))),
      },
    });

    const list = await service.listReports(createContext(), { limit: 20, offset: 0 });
    expect(list.total).toBe(1);
    expect(list.reports[0]).toMatchObject({
      id: 'dar_1',
      status: 'COMPLETED',
      preview: {
        summary: 'Engineering-heavy corpus.',
      },
    });

    const detail = await service.getReport(createContext(), 'dar_1');
    expect(detail.report).toMatchObject({
      overview: {
        deduplicatedMemoryCount: 900,
      },
      persona: {
        summary: 'The user prefers structured engineering workflows.',
      },
    });
  });
});
