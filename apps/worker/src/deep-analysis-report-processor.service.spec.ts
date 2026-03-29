import type { AppConfig } from '@mem9/config';
import { gzipJson } from '@mem9/shared';
import { Logger } from '@nestjs/common';

import { DeepAnalysisReportProcessorService } from './deep-analysis-report-processor.service';

const TEST_QWEN_MODEL = 'test-qwen-model';

function createConfig(overrides?: Partial<AppConfig['analysis']>): AppConfig {
  return {
    app: {
      env: 'test',
      port: 3000,
      workerHealthPort: 3001,
      logLevel: 'info',
      pepper: 'test-pepper-1234567890',
    },
    sentry: {
      dsn: undefined,
    },
    database: {
      url: 'mysql://localhost/mem9',
    },
    redis: {
      url: 'redis://localhost:6379',
    },
    aws: {
      region: 'us-east-1',
      forcePathStyle: false,
      s3BucketAnalysisPayloads: 'bucket',
      sqsAnalysisBatchQueueUrl: 'analysis-batch',
      sqsAnalysisBatchDlqUrl: 'analysis-batch-dlq',
      sqsAnalysisLlmQueueUrl: 'analysis-llm',
      sqsAnalysisLlmDlqUrl: 'analysis-llm-dlq',
    },
    analysis: {
      jobResultTtlSeconds: 86400,
      payloadRetentionDays: 7,
      defaultBatchSize: 100,
      maxBatchMemories: 100,
      maxBatchBytes: 1024 * 1024,
      maxMemoriesPerRequest: 100,
      pipelineVersion: 'v1',
      taxonomyVersion: 'v3',
      mem9SourceApiBaseUrl: 'http://127.0.0.1:8080/v1alpha2/mem9s',
      mem9SourcePageSize: 200,
      mem9SourceRequestTimeoutMs: 10000,
      mem9SourceFetchRetries: 2,
      mem9SourceFetchRetryBaseMs: 250,
      mem9SourceDeleteConcurrency: 4,
      deepAnalysisDailyLimitBypassFingerprints: [],
      qwenApiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      qwenApiKey: 'test-qwen-key',
      qwenModel: TEST_QWEN_MODEL,
      qwenRequestTimeoutMs: 120000,
      deepAnalysisChunkConcurrency: 5,
      ...overrides,
    },
    goVerify: {
      mode: 'noop',
      baseUrl: 'http://127.0.0.1:8080',
      sharedSecret: 'local-secret',
    },
    sqs: {
      waitTimeSeconds: 10,
      visibilityTimeoutSeconds: 30,
      visibilityHeartbeatSeconds: 10,
    },
  };
}

function createChunkResult(overrides?: {
  index?: number;
  success?: boolean;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestedAt?: string;
  finishedAt?: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  parsed?: Record<string, unknown> | null;
}) {
  const promptTokens = Object.prototype.hasOwnProperty.call(
    overrides ?? {},
    'promptTokens',
  )
    ? (overrides?.promptTokens ?? null)
    : 10;
  const completionTokens = Object.prototype.hasOwnProperty.call(
    overrides ?? {},
    'completionTokens',
  )
    ? (overrides?.completionTokens ?? null)
    : 2;
  const totalTokens = Object.prototype.hasOwnProperty.call(
    overrides ?? {},
    'totalTokens',
  )
    ? (overrides?.totalTokens ?? null)
    : 12;
  const parsed = Object.prototype.hasOwnProperty.call(overrides ?? {}, 'parsed')
    ? (overrides?.parsed ?? null)
    : {
        summary: `chunk ${overrides?.index ?? 1}`,
        themes: [
          {
            name: `theme-${overrides?.index ?? 1}`,
            memoryIds: [`mem_${overrides?.index ?? 1}`],
          },
        ],
        entities: {
          people: [`Person ${overrides?.index ?? 1}`],
          teams: [],
          projects: [],
          tools: [],
          places: [],
        },
        personaSignals: {
          workingStyle: [`Working style ${overrides?.index ?? 1}`],
          goals: [],
          preferences: [],
          constraints: [],
          decisionSignals: [],
          notableRoutines: [],
          contradictionsOrTensions: [],
        },
        relationships: [],
      };

  return {
    parsed,
    usage: {
      model: TEST_QWEN_MODEL,
      promptTokens,
      completionTokens,
      totalTokens,
      usageMissing:
        promptTokens === null ||
        completionTokens === null ||
        totalTokens === null,
    },
    requestMeta: {
      stage: 'chunk_analysis' as const,
      success: overrides?.success ?? true,
      requested: true,
      httpStatus: overrides?.httpStatus ?? 200,
      parseSucceeded: (overrides?.success ?? true) && parsed !== null,
      errorCode: overrides?.errorCode ?? null,
      errorMessage: overrides?.errorMessage ?? null,
      requestedAt: overrides?.requestedAt ?? '2026-03-28T00:00:00.000Z',
      finishedAt: overrides?.finishedAt ?? '2026-03-28T00:00:01.000Z',
    },
  };
}

function createSynthesisResult() {
  return {
    parsed: null,
    usage: {
      model: TEST_QWEN_MODEL,
      promptTokens: 90,
      completionTokens: 20,
      totalTokens: 110,
      usageMissing: false,
    },
    requestMeta: {
      stage: 'global_synthesis' as const,
      success: false,
      requested: true,
      httpStatus: 200,
      parseSucceeded: false,
      errorCode: 'QWEN_JSON_PARSE_FAILED',
      errorMessage: 'Unexpected token',
      requestedAt: '2026-03-28T00:00:02.000Z',
      finishedAt: '2026-03-28T00:00:03.000Z',
    },
    rawResponse: {
      source: 'message_content' as const,
      preview: '{"summary": invalid json',
      truncated: false,
    },
  };
}

describe('deep analysis report processor service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds a completed report with cleaned themes, entities, duplicate counts, and usage audit', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
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
      getObjectBuffer: jest.fn(async () =>
        gzipJson({
          fetchedAt: '2026-03-28T00:00:00Z',
          memoryCount: 4,
          memories: [
            {
              id: 'mem_1',
              content:
                'Prefer structured memory capture and work with Alice Johnson on the dashboard roadmap.',
              createdAt: '2026-03-20T00:00:00Z',
              updatedAt: '2026-03-20T00:00:00Z',
              memoryType: 'insight',
              tags: ['dashboard-roadmap'],
              metadata: null,
            },
            {
              id: 'mem_2',
              content:
                'Prefer structured memory capture and work with Alice Johnson on the dashboard roadmap.',
              createdAt: '2026-03-21T00:00:00Z',
              updatedAt: '2026-03-21T00:00:00Z',
              memoryType: 'insight',
              tags: ['dashboard-roadmap'],
              metadata: null,
            },
            {
              id: 'mem_3',
              content:
                'Every morning Bosn reviews traffic dashboards and prioritizes concise but detailed summaries for the Platform Team.',
              createdAt: '2026-03-22T00:00:00Z',
              updatedAt: '2026-03-22T00:00:00Z',
              memoryType: 'insight',
              tags: ['traffic-ops'],
              metadata: null,
            },
            {
              id: 'mem_4',
              content:
                'Need to automate duplicate cleanup for memory analysis while keeping canonical entries stable.',
              createdAt: '2026-03-23T00:00:00Z',
              updatedAt: '2026-03-23T00:00:00Z',
              memoryType: 'insight',
              tags: ['memory-analysis'],
              metadata: null,
            },
          ],
        }),
      ),
      putJson: jest.fn(async () => undefined),
    };
    const qwen = {
      getConfiguredModel: jest.fn(() => TEST_QWEN_MODEL),
      createJson: jest
        .fn()
        .mockImplementationOnce(async () => ({
          ...createChunkResult({
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150,
            parsed: {
              summary:
                'Alice and Bosn repeatedly align on dashboard roadmap execution.',
              themes: [
                { name: 'dashboard roadmap', memoryIds: ['mem_1', 'mem_3'] },
              ],
              entities: {
                people: ['Alice Johnson', 'Bosn'],
                teams: ['Platform Team'],
                projects: ['dashboard roadmap'],
                tools: ['React'],
                places: [],
              },
              personaSignals: {
                workingStyle: [
                  'Prefers structured reviews and staged rollout decisions.',
                ],
                goals: ['Keep memory insight workflows durable.'],
                preferences: ['Concise but information-dense summaries.'],
                constraints: ['Do not delete canonical memories.'],
                decisionSignals: [
                  'Balances speed and correctness in dashboard work.',
                ],
                notableRoutines: ['Reviews traffic dashboards every morning.'],
                contradictionsOrTensions: [
                  'Wants concise output without losing implementation detail.',
                ],
              },
              relationships: [],
            },
          }),
        }))
        .mockImplementationOnce(async () => createSynthesisResult()),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
      createConfig() as never,
    );

    await processor.process({
      messageType: 'deep_report',
      reportId: 'dar_1',
      traceId: 'trace_1',
    });

    expect(storage.putJson).toHaveBeenCalledTimes(1);
    const [, report] = storage.putJson.mock.calls[0] as unknown as [
      string,
      {
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
      },
    ];

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
      expect.arrayContaining(['focus_area', 'hygiene']),
    );
    expect(
      report.themeLandscape.highlights.map((item) => item.name),
    ).not.toEqual(expect.arrayContaining(['the', 'for', 'user', 'team']));
    expect(report.entities.people.map((item) => item.label)).toEqual(
      expect.arrayContaining(['Alice Johnson', 'Bosn']),
    );
    expect(report.entities.teams.map((item) => item.label)).not.toEqual(
      expect.arrayContaining(['team', 'Platform']),
    );
    expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '"event":"deep_analysis_chunk_analysis_started"',
        ),
        expect.stringContaining('"event":"deep_analysis_chunk_started"'),
        expect.stringContaining('"event":"deep_analysis_chunk_completed"'),
        expect.stringContaining(
          '"event":"deep_analysis_global_synthesis_started"',
        ),
        expect.stringContaining(
          '"event":"deep_analysis_global_synthesis_completed"',
        ),
        expect.stringContaining('"event":"deep_analysis_report_completed"'),
      ]),
    );

    const internalCommentUpdates = (
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<
        [string, { internalComment?: string }]
      >
    )
      .map((call) => call[1]?.internalComment)
      .filter((value): value is string => typeof value === 'string')
      .map(
        (value) =>
          JSON.parse(value) as {
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
          },
      );
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
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<
        [string, { internalComment?: string }]
      >
    ).at(-1);
    const finalPayload = finalCall?.[1];
    expect(finalPayload?.internalComment).toBeTruthy();
    const finalInternalComment = JSON.parse(
      String(finalPayload?.internalComment),
    ) as {
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

  it('updates progress within chunk analysis for large reports', async () => {
    const memories = Array.from({ length: 181 }, (_, index) => ({
      id: `mem_${index + 1}`,
      content: `Every morning Bosn reviews React dashboard roadmap item ${index + 1} with Alice Johnson and prefers structured automation decisions for the Platform Team.`,
      createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      updatedAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      memoryType: 'insight',
      tags: [`dashboard-${index + 1}`],
      metadata: null,
    }));
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_progress',
        status: 'QUEUED',
        lang: 'en',
        sourceSnapshotObjectKey:
          'deep-analysis/reports/dar_progress/source.json.gz',
        internalComment: null,
      })),
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () =>
        gzipJson({
          fetchedAt: '2026-03-28T00:00:00Z',
          memoryCount: memories.length,
          memories,
        }),
      ),
      putJson: jest.fn(async () => undefined),
    };
    const qwen = {
      getConfiguredModel: jest.fn(() => TEST_QWEN_MODEL),
      createJson: jest
        .fn()
        .mockImplementationOnce(async () =>
          createChunkResult({
            success: false,
            httpStatus: 200,
            errorCode: 'QWEN_JSON_PARSE_FAILED',
            errorMessage: 'Unexpected token',
            parsed: null,
          }),
        )
        .mockImplementationOnce(async () =>
          createChunkResult({
            success: false,
            httpStatus: 200,
            errorCode: 'QWEN_JSON_PARSE_FAILED',
            errorMessage: 'Unexpected token',
            requestedAt: '2026-03-28T00:00:02.000Z',
            finishedAt: '2026-03-28T00:00:03.000Z',
            parsed: null,
          }),
        )
        .mockImplementationOnce(async () => createSynthesisResult()),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
      createConfig() as never,
    );

    await processor.process({
      messageType: 'deep_report',
      reportId: 'dar_progress',
      traceId: 'trace_progress',
    });

    const progressUpdates = (
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<
        [string, { progressPercent?: number }]
      >
    )
      .map((call) => call[1]?.progressPercent)
      .filter((value): value is number => typeof value === 'number');

    expect(progressUpdates).toEqual(
      expect.arrayContaining([10, 35, 47, 59, 60, 90, 100]),
    );
  });

  it('filters malformed chunk theme and relationship fields instead of crashing before synthesis', async () => {
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_malformed_chunk',
        status: 'QUEUED',
        lang: 'en',
        sourceSnapshotObjectKey:
          'deep-analysis/reports/dar_malformed_chunk/source.json.gz',
        internalComment: null,
      })),
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () =>
        gzipJson({
          fetchedAt: '2026-03-28T00:00:00Z',
          memoryCount: 4,
          memories: [
            {
              id: 'mem_1',
              content:
                'Prefer structured memory capture and work with Alice Johnson on the dashboard roadmap.',
              createdAt: '2026-03-20T00:00:00Z',
              updatedAt: '2026-03-20T00:00:00Z',
              memoryType: 'insight',
              tags: ['dashboard-roadmap'],
              metadata: null,
            },
            {
              id: 'mem_2',
              content:
                'Every morning Bosn reviews traffic dashboards and prioritizes concise but detailed summaries for the Platform Team.',
              createdAt: '2026-03-21T00:00:00Z',
              updatedAt: '2026-03-21T00:00:00Z',
              memoryType: 'insight',
              tags: ['traffic-ops'],
              metadata: null,
            },
            {
              id: 'mem_3',
              content:
                'Need to automate duplicate cleanup for memory analysis while keeping canonical entries stable.',
              createdAt: '2026-03-22T00:00:00Z',
              updatedAt: '2026-03-22T00:00:00Z',
              memoryType: 'insight',
              tags: ['memory-analysis'],
              metadata: null,
            },
            {
              id: 'mem_4',
              content:
                'Bosn plans to keep dashboard reporting workflows durable and document tradeoffs explicitly.',
              createdAt: '2026-03-23T00:00:00Z',
              updatedAt: '2026-03-23T00:00:00Z',
              memoryType: 'insight',
              tags: ['dashboard-roadmap'],
              metadata: null,
            },
          ],
        }),
      ),
      putJson: jest.fn(async () => undefined),
    };
    const qwen = {
      getConfiguredModel: jest.fn(() => TEST_QWEN_MODEL),
      createJson: jest
        .fn()
        .mockImplementationOnce(async () =>
          createChunkResult({
            parsed: {
              summary: 'dashboard collaboration and reporting routines',
              themes: [
                { name: 'dashboard roadmap', memoryIds: ['mem_1', 'mem_4'] },
                { memoryIds: ['mem_2'] },
              ],
              entities: {
                people: ['Alice Johnson', 'Bosn'],
                teams: ['Platform Team'],
                projects: ['dashboard roadmap'],
                tools: ['React'],
                places: [],
              },
              personaSignals: {
                workingStyle: [
                  'Prefers structured reviews and staged rollout decisions.',
                ],
                goals: ['Keep memory workflows durable.'],
                preferences: ['Concise but information-dense summaries.'],
                constraints: ['Do not delete canonical memories.'],
                decisionSignals: [
                  'Balances speed and correctness in dashboard work.',
                ],
                notableRoutines: ['Reviews dashboards every morning.'],
                contradictionsOrTensions: [
                  'Wants concise output without losing implementation detail.',
                ],
              },
              relationships: [
                {
                  source: 'user',
                  relation: 'works_with',
                  target: 'Alice Johnson',
                  confidence: 0.82,
                  evidenceMemoryIds: ['mem_1'],
                  evidenceExcerpts: [
                    'Prefer structured memory capture and work with Alice Johnson on the dashboard roadmap.',
                  ],
                },
                {
                  source: 'user',
                  relation: 'works_with',
                  confidence: 0.5,
                  evidenceMemoryIds: ['mem_2'],
                  evidenceExcerpts: ['invalid relationship without target'],
                },
              ],
            },
          }),
        )
        .mockImplementationOnce(async () => createSynthesisResult()),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
      createConfig() as never,
    );

    await processor.process({
      messageType: 'deep_report',
      reportId: 'dar_malformed_chunk',
      traceId: 'trace_malformed_chunk',
    });

    expect(qwen.createJson).toHaveBeenCalledTimes(2);
    expect(qwen.createJson).toHaveBeenNthCalledWith(
      2,
      'global_synthesis',
      expect.any(String),
      expect.any(String),
    );
    expect(repository.updateDeepAnalysisReport).toHaveBeenLastCalledWith(
      'dar_malformed_chunk',
      expect.objectContaining({
        status: 'COMPLETED',
        stage: 'COMPLETE',
        progressPercent: 100,
        internalComment: expect.any(String),
      }),
    );

    const finalCall = (
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<
        [string, { internalComment?: string }]
      >
    ).at(-1);
    const finalInternalComment = JSON.parse(
      String(finalCall?.[1]?.internalComment),
    ) as {
      calls: Array<{
        stage: string;
        success: boolean;
      }>;
    };
    expect(finalInternalComment.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'chunk_analysis',
          success: true,
        }),
        expect.objectContaining({
          stage: 'global_synthesis',
          success: false,
        }),
      ]),
    );
  });

  it('limits chunk analysis to five concurrent Qwen requests', async () => {
    const memories = Array.from({ length: 1081 }, (_, index) => ({
      id: `mem_${index + 1}`,
      content: `Memory ${index + 1} about Bosn, React, automation, and dashboard work with Alice Johnson.`,
      createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      updatedAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      memoryType: 'insight',
      tags: [`tag-${index + 1}`],
      metadata: null,
    }));
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_concurrency',
        status: 'QUEUED',
        lang: 'en',
        sourceSnapshotObjectKey:
          'deep-analysis/reports/dar_concurrency/source.json.gz',
        internalComment: null,
      })),
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () =>
        gzipJson({
          fetchedAt: '2026-03-28T00:00:00Z',
          memoryCount: memories.length,
          memories,
        }),
      ),
      putJson: jest.fn(async () => undefined),
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const pendingChunkResolves: Array<() => void> = [];
    const qwen = {
      getConfiguredModel: jest.fn(() => TEST_QWEN_MODEL),
      createJson: jest.fn(async (stage: string) => {
        if (stage === 'global_synthesis') {
          return createSynthesisResult();
        }

        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          pendingChunkResolves.push(() => {
            inFlight -= 1;
            resolve();
          });
        });

        return createChunkResult();
      }),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
      createConfig({
        deepAnalysisChunkConcurrency: 5,
      }) as never,
    );

    const processPromise = processor.process({
      messageType: 'deep_report',
      reportId: 'dar_concurrency',
      traceId: 'trace_concurrency',
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(maxInFlight).toBe(5);
    expect(pendingChunkResolves).toHaveLength(5);

    pendingChunkResolves.splice(0).forEach((resolve) => resolve());
    for (
      let attempt = 0;
      attempt < 20 && pendingChunkResolves.length < 2;
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(maxInFlight).toBe(5);

    pendingChunkResolves.splice(0).forEach((resolve) => resolve());
    await processPromise;

    expect(qwen.createJson).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBe(5);
  });

  it('stores runtime trim errors and recent event logs in internal comment when processing fails', async () => {
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_trim_failure',
        status: 'QUEUED',
        lang: 'en',
        sourceSnapshotObjectKey:
          'deep-analysis/reports/dar_trim_failure/source.json.gz',
        internalComment: null,
      })),
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () =>
        gzipJson({
          fetchedAt: '2026-03-28T00:00:00Z',
          memoryCount: 4,
          memories: [
            {
              id: 'mem_1',
              content:
                'Prefer structured memory capture and work with Alice Johnson on the dashboard roadmap.',
              createdAt: '2026-03-20T00:00:00Z',
              updatedAt: '2026-03-20T00:00:00Z',
              memoryType: 'insight',
              tags: ['dashboard-roadmap'],
              metadata: null,
            },
            {
              id: 'mem_2',
              content:
                'Every morning Bosn reviews traffic dashboards and prioritizes concise but detailed summaries for the Platform Team.',
              createdAt: '2026-03-21T00:00:00Z',
              updatedAt: '2026-03-21T00:00:00Z',
              memoryType: 'insight',
              tags: ['traffic-ops'],
              metadata: null,
            },
            {
              id: 'mem_3',
              content:
                'Need to automate duplicate cleanup for memory analysis while keeping canonical entries stable.',
              createdAt: '2026-03-22T00:00:00Z',
              updatedAt: '2026-03-22T00:00:00Z',
              memoryType: 'insight',
              tags: ['memory-analysis'],
              metadata: null,
            },
            {
              id: 'mem_4',
              content:
                'Bosn plans to keep dashboard reporting workflows durable and document tradeoffs explicitly.',
              createdAt: '2026-03-23T00:00:00Z',
              updatedAt: '2026-03-23T00:00:00Z',
              memoryType: 'insight',
              tags: ['dashboard-roadmap'],
              metadata: null,
            },
          ],
        }),
      ),
      putJson: jest.fn(async () => undefined),
    };
    const qwen = {
      getConfiguredModel: jest.fn(() => TEST_QWEN_MODEL),
      createJson: jest
        .fn()
        .mockImplementationOnce(async () =>
          createChunkResult({
            parsed: {
              summary: 'dashboard collaboration and reporting routines',
              themes: [
                { name: 'dashboard roadmap', memoryIds: ['mem_1', 'mem_4'] },
              ],
              entities: {
                people: ['Alice Johnson', 'Bosn'],
                teams: ['Platform Team'],
                projects: ['dashboard roadmap'],
                tools: ['React'],
                places: [],
              },
              personaSignals: {
                workingStyle: [
                  'Prefers structured reviews and staged rollout decisions.',
                ],
                goals: ['Keep memory workflows durable.'],
                preferences: ['Concise but information-dense summaries.'],
                constraints: ['Do not delete canonical memories.'],
                decisionSignals: [
                  'Balances speed and correctness in dashboard work.',
                ],
                notableRoutines: ['Reviews dashboards every morning.'],
                contradictionsOrTensions: [
                  'Wants concise output without losing implementation detail.',
                ],
              },
              relationships: [],
            },
          }),
        )
        .mockImplementationOnce(async () => {
          throw new TypeError(
            "Cannot read properties of undefined (reading 'trim')",
          );
        }),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
      createConfig() as never,
    );

    await processor.process({
      messageType: 'deep_report',
      reportId: 'dar_trim_failure',
      traceId: 'trace_trim_failure',
    });

    expect(repository.updateDeepAnalysisReport).toHaveBeenLastCalledWith(
      'dar_trim_failure',
      expect.objectContaining({
        status: 'FAILED',
        stage: 'VALIDATE',
        errorCode: 'DEEP_ANALYSIS_PROCESSING_FAILED',
        errorMessage: "Cannot read properties of undefined (reading 'trim')",
        internalComment: expect.any(String),
      }),
    );

    const finalCall = (
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<
        [string, { internalComment?: string }]
      >
    ).at(-1);
    const finalInternalComment = JSON.parse(
      String(finalCall?.[1]?.internalComment),
    ) as {
      events: Array<{
        event: string;
        stage: string;
      }>;
      runtimeErrors: Array<{
        stage: string;
        errorMessage: string;
        isTrimError: boolean;
        stack: string | null;
      }>;
    };
    expect(finalInternalComment.events.map((item) => item.event)).toEqual(
      expect.arrayContaining([
        'deep_analysis_process_started',
        'deep_analysis_chunk_analysis_started',
        'deep_analysis_chunk_started',
        'deep_analysis_chunk_completed',
        'deep_analysis_global_synthesis_started',
        'deep_analysis_report_failed',
      ]),
    );
    expect(finalInternalComment.runtimeErrors).toEqual([
      expect.objectContaining({
        stage: 'GLOBAL_SYNTHESIS',
        errorMessage: "Cannot read properties of undefined (reading 'trim')",
        isTrimError: true,
        stack: expect.any(String),
      }),
    ]);
  });

  it('repairs synthesized reports with invalid evidence ids and preserves LLM narrative fields', async () => {
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_validation_failure',
        status: 'QUEUED',
        lang: 'en',
        sourceSnapshotObjectKey:
          'deep-analysis/reports/dar_validation_failure/source.json.gz',
        internalComment: null,
      })),
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () =>
        gzipJson({
          fetchedAt: '2026-03-28T00:00:00Z',
          memoryCount: 4,
          memories: [
            {
              id: 'mem_1',
              content:
                'Prefer structured memory capture and work with Alice Johnson on the dashboard roadmap.',
              createdAt: '2026-03-20T00:00:00Z',
              updatedAt: '2026-03-20T00:00:00Z',
              memoryType: 'insight',
              tags: ['dashboard-roadmap'],
              metadata: null,
            },
            {
              id: 'mem_2',
              content:
                'Every morning Bosn reviews traffic dashboards and prioritizes concise but detailed summaries for the Platform Team.',
              createdAt: '2026-03-21T00:00:00Z',
              updatedAt: '2026-03-21T00:00:00Z',
              memoryType: 'insight',
              tags: ['traffic-ops'],
              metadata: null,
            },
            {
              id: 'mem_3',
              content:
                'Need to automate duplicate cleanup for memory analysis while keeping canonical entries stable.',
              createdAt: '2026-03-22T00:00:00Z',
              updatedAt: '2026-03-22T00:00:00Z',
              memoryType: 'insight',
              tags: ['memory-analysis'],
              metadata: null,
            },
            {
              id: 'mem_4',
              content:
                'Bosn plans to keep dashboard reporting workflows durable and document tradeoffs explicitly.',
              createdAt: '2026-03-23T00:00:00Z',
              updatedAt: '2026-03-23T00:00:00Z',
              memoryType: 'insight',
              tags: ['dashboard-roadmap'],
              metadata: null,
            },
          ],
        }),
      ),
      putJson: jest.fn(async () => undefined),
    };
    const invalidSynthesisReport = {
      overview: {
        memoryCount: 4,
        deduplicatedMemoryCount: 4,
        generatedAt: '2026-03-28T00:00:05.000Z',
        lang: 'en',
        timeSpan: {
          start: '2026-03-20T00:00:00.000Z',
          end: '2026-03-23T00:00:00.000Z',
        },
      },
      persona: {
        summary:
          'Bosn consistently structures dashboard and automation work around review loops, explicit tradeoffs, and durable operating habits that can survive repeated context switching.',
        workingStyle: ['Uses structured reviews and staged rollout decisions.'],
        goals: ['Keep memory insight workflows durable and actionable.'],
        preferences: ['Concise but information-dense summaries.'],
        constraints: ['Do not delete canonical memories without evidence.'],
        decisionSignals: ['Balances speed and correctness in dashboard work.'],
        notableRoutines: ['Reviews dashboards every morning.'],
        contradictionsOrTensions: [
          'Wants concise output without losing implementation detail.',
        ],
        evidenceHighlights: [
          {
            title: 'Dashboard review',
            detail:
              'Structured review loop around dashboards and prioritization.',
            memoryIds: ['mem_1'],
          },
        ],
      },
      themeLandscape: [
        {
          name: 'dashboard roadmap',
          count: 2,
          description: 'Repeated dashboard planning and reporting work.',
        },
      ],
      entities: {
        people: [
          {
            label: 'Alice Johnson',
            role: 'Partner',
            count: 1,
            evidenceMemoryIds: ['chunk_insight_2'],
          },
        ],
        teams: [
          {
            label: 'Platform Team',
            function: 'Operations',
            count: 1,
            evidenceMemoryIds: ['mem_2'],
          },
        ],
        projects: [
          {
            label: 'dashboard roadmap',
            description: 'Roadmap work',
            count: 2,
            evidenceMemoryIds: ['chunk_insight_3'],
          },
        ],
        tools: [
          {
            label: 'React',
            category: 'frontend',
            count: 1,
            evidenceMemoryIds: ['mem_1'],
          },
        ],
        places: [],
      },
      relationships: [],
      discoveries: [
        {
          id: 'focus:bad-memory',
          kind: 'focus_area' as const,
          title: 'Focus area',
          summary:
            'The report intentionally references a bad memory id for validation diagnostics.',
          confidence: 0.82,
          evidenceMemoryIds: ['missing_mem_1'],
        },
      ],
      quality: {
        duplicateRatio: 0,
        duplicateMemoryCount: 0,
        noisyMemoryCount: 0,
        duplicateClusters: [],
        lowQualityExamples: [],
        coverageGaps: [],
      },
      recommendations: ['Keep the dashboard roadmap well documented.'],
      productSignals: {
        candidateNodes: [],
        candidateEdges: [],
        searchSeeds: ['dashboard roadmap'],
      },
    };
    const qwen = {
      getConfiguredModel: jest.fn(() => TEST_QWEN_MODEL),
      createJson: jest
        .fn()
        .mockImplementationOnce(async () =>
          createChunkResult({
            parsed: {
              summary: 'dashboard collaboration and reporting routines',
              themes: [
                { name: 'dashboard roadmap', memoryIds: ['mem_1', 'mem_4'] },
              ],
              entities: {
                people: ['Alice Johnson', 'Bosn'],
                teams: ['Platform Team'],
                projects: ['dashboard roadmap'],
                tools: ['React'],
                places: [],
              },
              personaSignals: {
                workingStyle: [
                  'Prefers structured reviews and staged rollout decisions.',
                ],
                goals: ['Keep memory workflows durable.'],
                preferences: ['Concise but information-dense summaries.'],
                constraints: ['Do not delete canonical memories.'],
                decisionSignals: [
                  'Balances speed and correctness in dashboard work.',
                ],
                notableRoutines: ['Reviews dashboards every morning.'],
                contradictionsOrTensions: [
                  'Wants concise output without losing implementation detail.',
                ],
              },
              relationships: [],
            },
          }),
        )
        .mockImplementationOnce(async () => ({
          parsed: invalidSynthesisReport,
          usage: {
            model: TEST_QWEN_MODEL,
            promptTokens: 100,
            completionTokens: 40,
            totalTokens: 140,
            usageMissing: false,
          },
          requestMeta: {
            stage: 'global_synthesis' as const,
            success: true,
            requested: true,
            httpStatus: 200,
            parseSucceeded: true,
            errorCode: null,
            errorMessage: null,
            requestedAt: '2026-03-28T00:00:02.000Z',
            finishedAt: '2026-03-28T00:00:03.000Z',
          },
          rawResponse: null,
        })),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
      createConfig() as never,
    );

    await processor.process({
      messageType: 'deep_report',
      reportId: 'dar_validation_failure',
      traceId: 'trace_validation_failure',
    });

    expect(repository.updateDeepAnalysisReport).toHaveBeenLastCalledWith(
      'dar_validation_failure',
      expect.objectContaining({
        status: 'COMPLETED',
        stage: 'COMPLETE',
        internalComment: expect.any(String),
      }),
    );

    expect(storage.putJson).toHaveBeenCalledTimes(1);
    const [, storedReport] = storage.putJson.mock.calls[0] as unknown as [
      string,
      {
        persona: { summary: string };
        themeLandscape: {
          highlights: Array<{ name: string; description: string }>;
        };
        entities: {
          people: Array<{ label: string; evidenceMemoryIds: string[] }>;
          projects: Array<{ label: string; evidenceMemoryIds: string[] }>;
        };
        discoveries: Array<{ title: string; evidenceMemoryIds: string[] }>;
      },
    ];

    expect(storedReport.persona.summary).toBe(
      invalidSynthesisReport.persona.summary,
    );
    expect(storedReport.themeLandscape.highlights).toEqual([
      expect.objectContaining({
        name: 'dashboard roadmap',
        description: 'Repeated dashboard planning and reporting work.',
      }),
    ]);
    expect(storedReport.entities.people).toEqual([
      expect.objectContaining({
        label: 'Alice Johnson',
        evidenceMemoryIds: ['mem_1'],
      }),
    ]);
    expect(storedReport.entities.projects).toEqual([
      expect.objectContaining({
        label: 'dashboard roadmap',
        evidenceMemoryIds: ['mem_1', 'mem_4'],
      }),
    ]);
    expect(storedReport.discoveries).toEqual([
      expect.objectContaining({
        title: 'Focus area',
      }),
    ]);
    const allEvidenceIds = [
      ...storedReport.entities.people.flatMap((item) => item.evidenceMemoryIds),
      ...storedReport.entities.projects.flatMap(
        (item) => item.evidenceMemoryIds,
      ),
      ...storedReport.discoveries.flatMap((item) => item.evidenceMemoryIds),
    ];
    expect(storedReport.discoveries[0]?.evidenceMemoryIds).toEqual(
      expect.arrayContaining(['mem_1', 'mem_4']),
    );
    expect(allEvidenceIds).not.toEqual(
      expect.arrayContaining([
        'chunk_insight_2',
        'chunk_insight_3',
        'missing_mem_1',
      ]),
    );
    expect(
      allEvidenceIds.every((memoryId) =>
        ['mem_1', 'mem_2', 'mem_3', 'mem_4'].includes(memoryId),
      ),
    ).toBe(true);

    const finalCall = (
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<
        [string, { internalComment?: string }]
      >
    ).at(-1);
    const finalInternalComment = JSON.parse(
      String(finalCall?.[1]?.internalComment),
    ) as {
      events: Array<{ event: string }>;
      runtimeErrors: Array<unknown>;
      rawResponses: Array<{
        stage: string;
        reason: string;
        source: string;
        preview: string;
      }>;
    };

    expect(finalInternalComment.events.map((item) => item.event)).toEqual(
      expect.arrayContaining([
        'deep_analysis_report_repaired',
        'deep_analysis_report_completed',
      ]),
    );
    expect(finalInternalComment.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'deep_analysis_report_repaired',
          fields: expect.objectContaining({
            invalidEvidenceIdCount: 3,
            invalidEvidenceIdsSample:
              expect.stringContaining('chunk_insight_2'),
          }),
        }),
      ]),
    );
    expect(finalInternalComment.runtimeErrors).toEqual([]);
    expect(finalInternalComment.rawResponses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'GLOBAL_SYNTHESIS',
          reason: 'report_repaired',
          source: 'parsed_report',
          preview: expect.stringContaining('chunk_insight_2'),
        }),
      ]),
    );
  });

  it('keeps internal comment audit consistent when chunks finish out of order and one times out', async () => {
    const memories = Array.from({ length: 181 }, (_, index) => ({
      id: `mem_${index + 1}`,
      content: `Audited memory ${index + 1} about dashboards, automation, and collaboration.`,
      createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      updatedAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      memoryType: 'insight',
      tags: [`audit-${index + 1}`],
      metadata: null,
    }));
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_audit',
        status: 'QUEUED',
        lang: 'en',
        sourceSnapshotObjectKey:
          'deep-analysis/reports/dar_audit/source.json.gz',
        internalComment: null,
      })),
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () =>
        gzipJson({
          fetchedAt: '2026-03-28T00:00:00Z',
          memoryCount: memories.length,
          memories,
        }),
      ),
      putJson: jest.fn(async () => undefined),
    };
    let firstResolve: (() => void) | undefined;
    let secondResolve: (() => void) | undefined;
    let chunkCallCount = 0;
    const qwen = {
      getConfiguredModel: jest.fn(() => TEST_QWEN_MODEL),
      createJson: jest.fn(async (stage: string) => {
        if (stage === 'global_synthesis') {
          return createSynthesisResult();
        }

        chunkCallCount += 1;
        if (chunkCallCount === 1) {
          await new Promise<void>((resolve) => {
            firstResolve = resolve;
          });
          return createChunkResult({
            index: 1,
            promptTokens: 11,
            completionTokens: 3,
            totalTokens: 14,
          });
        }

        await new Promise<void>((resolve) => {
          secondResolve = resolve;
        });
        return createChunkResult({
          index: 2,
          success: false,
          httpStatus: null,
          errorCode: 'QWEN_REQUEST_TIMEOUT',
          errorMessage: 'Qwen request timed out after 120000ms',
          requestedAt: '2026-03-28T00:00:02.000Z',
          finishedAt: '2026-03-28T00:02:02.000Z',
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          parsed: null,
        });
      }),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
      createConfig() as never,
    );

    const processPromise = processor.process({
      messageType: 'deep_report',
      reportId: 'dar_audit',
      traceId: 'trace_audit',
    });

    for (
      let attempt = 0;
      attempt < 20 && (!firstResolve || !secondResolve);
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    secondResolve?.();
    await new Promise((resolve) => setImmediate(resolve));
    firstResolve?.();
    await processPromise;

    const finalCall = (
      repository.updateDeepAnalysisReport.mock.calls as unknown as Array<
        [string, { internalComment?: string; status?: string }]
      >
    ).at(-1);
    expect(finalCall?.[1]?.status).toBe('COMPLETED');
    expect(finalCall?.[1]?.internalComment).toBeTruthy();

    const finalInternalComment = JSON.parse(
      String(finalCall?.[1]?.internalComment),
    ) as {
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
        errorCode: string | null;
      }>;
      rawResponses: Array<{
        stage: string;
        reason: string;
        source: string;
        preview: string;
      }>;
    };
    expect(finalInternalComment.aggregate).toEqual({
      requestCount: 3,
      successCount: 1,
      failureCount: 2,
      promptTokens: 101,
      completionTokens: 23,
      totalTokens: 124,
    });
    expect(finalInternalComment.calls).toEqual([
      expect.objectContaining({
        stage: 'chunk_analysis',
        index: 1,
        success: true,
        errorCode: null,
      }),
      expect.objectContaining({
        stage: 'chunk_analysis',
        index: 2,
        success: false,
        errorCode: 'QWEN_REQUEST_TIMEOUT',
      }),
      expect.objectContaining({
        stage: 'global_synthesis',
        index: 1,
        success: false,
        errorCode: 'QWEN_JSON_PARSE_FAILED',
      }),
    ]);
    expect(finalInternalComment.rawResponses).toEqual([
      expect.objectContaining({
        stage: 'global_synthesis',
        reason: 'qwen_json_parse_failed',
        source: 'message_content',
        preview: '{"summary": invalid json',
      }),
    ]);
  });

  it('preserves chunk insight order for synthesis even when chunk completions finish out of order', async () => {
    const memories = Array.from({ length: 181 }, (_, index) => ({
      id: `mem_${index + 1}`,
      content: `Ordered memory ${index + 1} about dashboards and automation.`,
      createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      updatedAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      memoryType: 'insight',
      tags: [`ordered-${index + 1}`],
      metadata: null,
    }));
    const repository = {
      getDeepAnalysisReport: jest.fn(async () => ({
        id: 'dar_order',
        status: 'QUEUED',
        lang: 'en',
        sourceSnapshotObjectKey:
          'deep-analysis/reports/dar_order/source.json.gz',
        internalComment: null,
      })),
      updateDeepAnalysisReport: jest.fn(async () => undefined),
    };
    const storage = {
      getObjectBuffer: jest.fn(async () =>
        gzipJson({
          fetchedAt: '2026-03-28T00:00:00Z',
          memoryCount: memories.length,
          memories,
        }),
      ),
      putJson: jest.fn(async () => undefined),
    };
    let chunkCallCount = 0;
    let firstResolve: (() => void) | undefined;
    let secondResolve: (() => void) | undefined;
    const qwen = {
      getConfiguredModel: jest.fn(() => TEST_QWEN_MODEL),
      createJson: jest.fn(
        async (stage: string, _systemPrompt: string, userPrompt: string) => {
          if (stage === 'global_synthesis') {
            const payload = JSON.parse(userPrompt) as {
              chunkInsights: Array<{ summary: string }>;
            };
            expect(payload.chunkInsights.map((item) => item.summary)).toEqual([
              'chunk-1',
              'chunk-2',
            ]);
            return createSynthesisResult();
          }

          chunkCallCount += 1;
          if (chunkCallCount === 1) {
            await new Promise<void>((resolve) => {
              firstResolve = resolve;
            });
            return createChunkResult({
              index: 1,
              parsed: {
                summary: 'chunk-1',
                themes: [],
                entities: {
                  people: [],
                  teams: [],
                  projects: [],
                  tools: [],
                  places: [],
                },
                personaSignals: {
                  workingStyle: ['chunk-1 style'],
                  goals: [],
                  preferences: [],
                  constraints: [],
                  decisionSignals: [],
                  notableRoutines: [],
                  contradictionsOrTensions: [],
                },
                relationships: [],
              },
            });
          }

          await new Promise<void>((resolve) => {
            secondResolve = resolve;
          });
          return createChunkResult({
            index: 2,
            parsed: {
              summary: 'chunk-2',
              themes: [],
              entities: {
                people: [],
                teams: [],
                projects: [],
                tools: [],
                places: [],
              },
              personaSignals: {
                workingStyle: ['chunk-2 style'],
                goals: [],
                preferences: [],
                constraints: [],
                decisionSignals: [],
                notableRoutines: [],
                contradictionsOrTensions: [],
              },
              relationships: [],
            },
          });
        },
      ),
    };
    const processor = new DeepAnalysisReportProcessorService(
      repository as never,
      storage as never,
      qwen as never,
      createConfig() as never,
    );

    const processPromise = processor.process({
      messageType: 'deep_report',
      reportId: 'dar_order',
      traceId: 'trace_order',
    });

    for (
      let attempt = 0;
      attempt < 20 && (!firstResolve || !secondResolve);
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    secondResolve?.();
    await new Promise((resolve) => setImmediate(resolve));
    firstResolve?.();
    await processPromise;
  });
});
