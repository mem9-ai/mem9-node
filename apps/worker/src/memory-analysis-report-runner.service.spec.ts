import type { AppConfig } from '@mem9/config';
import { AppError, deriveApiKeyFingerprint } from '@mem9/shared';

import { MEMORY_PERIOD_SUMMARY_CACHE_VERSION } from './memory-analysis/prompts';
import { MemoryAnalysisReportRunnerService } from './memory-analysis-report-runner.service';

const testPepper = 'test-pepper';
const reportApiKeyFingerprint = deriveApiKeyFingerprint(testPepper, 'space-key');
const reportContext = {
  apiKeyFingerprint: reportApiKeyFingerprint,
  apiKeyFingerprintHex: reportApiKeyFingerprint.toString('hex'),
  rawApiKey: 'space-key',
  requestId: 'req_1',
};

const TEST_CONFIG = {
  app: { pepper: testPepper },
  analysis: {
    qwenModel: 'test-model',
    qwenApiKey: 'test-qwen-key',
  },
} as AppConfig;

class FakeRedis {
  public readonly values = new Map<string, string>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly get = jest.fn(async (key: string) => this.values.get(key) ?? null);
  public readonly set = jest.fn(async (key: string, value: string) => {
    this.values.set(key, value);
    return 'OK';
  });
  public readonly sadd = jest.fn(async (key: string, value: string) => {
    const current = this.sets.get(key) ?? new Set<string>();
    current.add(value);
    this.sets.set(key, current);
    return current.size;
  });
  public readonly expire = jest.fn(async () => 1);
  public readonly del = jest.fn(async (...keys: string[]) => {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) {
        deleted += 1;
      }
      if (this.sets.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  });
}

function createReport(overrides: Record<string, unknown> = {}) {
  return {
    reportId: 1,
    apiKeyFingerprint: reportApiKeyFingerprint,
    templateId: 'memory_analysis',
    reportContent: '',
    generatedAt: new Date('2026-06-26T08:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    startTime: new Date('2026-06-01T00:00:00.000Z'),
    endTime: new Date('2026-06-14T23:59:59.999Z'),
    renderStatus: 'queued',
    reportStage: 'queued',
    failCode: null,
    failReason: null,
    memoryCount: 0,
    ...overrides,
  };
}

describe('MemoryAnalysisReportRunnerService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retries transient report generation failures before marking success', async () => {
    const source = {
      fetchSessionMemories: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary source failure'))
        .mockResolvedValue([]),
    };
    const repository = {
      findMemoryAnalysisReport: jest.fn(async () => createReport()),
      updateMemoryAnalysisReport: jest.fn<Promise<ReturnType<typeof createReport>>, [number, Buffer, unknown]>().mockResolvedValue(createReport()),
    };
    const runner = new MemoryAnalysisReportRunnerService(
      { app: { pepper: testPepper }, analysis: {} } as never,
      source as never,
      repository as never,
      new FakeRedis() as never,
    );

    await runner.generateReport(reportContext, 1, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    });

    expect(source.fetchSessionMemories).toHaveBeenCalledTimes(2);
    expect(repository.updateMemoryAnalysisReport).toHaveBeenCalledTimes(3);
    for (const [reportId, fingerprint] of repository.updateMemoryAnalysisReport.mock.calls) {
      expect(reportId).toBe(1);
      expect(fingerprint).toEqual(reportApiKeyFingerprint);
    }
    expect(repository.updateMemoryAnalysisReport).toHaveBeenLastCalledWith(1, reportApiKeyFingerprint, expect.objectContaining({
      renderStatus: 'success',
      reportStage: 'complete',
    }));
  });

  it('stores a specific failure reason when report generation cannot continue', async () => {
    const source = {
      fetchSessionMemories: jest.fn(async () => [
        {
          id: 'm1',
          content: 'memory content',
          createdAt: '2026-06-01T12:00:00.000Z',
          memoryType: 'session',
          tags: [],
          metadata: null,
        },
      ]),
    };
    const repository = {
      findMemoryAnalysisReport: jest.fn(async () => createReport()),
      updateMemoryAnalysisReport: jest.fn<Promise<ReturnType<typeof createReport>>, [number, Buffer, unknown]>().mockResolvedValue(createReport()),
    };
    const runner = new MemoryAnalysisReportRunnerService(
      { app: { pepper: testPepper }, analysis: {} } as never,
      source as never,
      repository as never,
      new FakeRedis() as never,
    );
    const errorSpy = jest
      .spyOn(runner['logger'], 'error')
      .mockImplementation(() => undefined);

    await runner.generateReport(reportContext, 1, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    });

    expect(repository.updateMemoryAnalysisReport).toHaveBeenLastCalledWith(1, reportApiKeyFingerprint, expect.objectContaining({
      renderStatus: 'fail',
      reportStage: 'failed',
      failCode: 'QWEN_NOT_CONFIGURED',
      failReason: 'Qwen API key or model is not configured.',
    }));
    expect(errorSpy).toHaveBeenCalled();
    for (const [reportId, fingerprint] of repository.updateMemoryAnalysisReport.mock.calls) {
      expect(reportId).toBe(1);
      expect(fingerprint).toEqual(reportApiKeyFingerprint);
    }
  });

  function setupIsolatedReport() {
    const source = { fetchSessionMemories: jest.fn(async () => []) };
    const repository = {
      findMemoryAnalysisReport: jest.fn(async () => createReport() as ReturnType<typeof createReport> | null),
      updateMemoryAnalysisReport: jest.fn<Promise<ReturnType<typeof createReport>>, [number, Buffer, unknown]>().mockResolvedValue(createReport()),
    };
    const redis = new FakeRedis();
    const runner = new MemoryAnalysisReportRunnerService(TEST_CONFIG, source as never, repository as never, redis as never);
    const range = { createdAfter: '2026-06-01T00:00:00.000Z', createdBefore: '2026-06-14T23:59:59.999Z' };
    return { source, repository, redis, runner, range };
  }

  it.each(['missing', 'different owner', 'different start', 'different end'])('does not write a failure or read source for a %s report', async (scenario) => {
    const { source, repository, redis, runner, range } = setupIsolatedReport();
    const overrides = scenario === 'different owner' ? { apiKeyFingerprint: Buffer.alloc(32, 9) }
      : scenario === 'different start' ? { startTime: new Date('2026-06-02T00:00:00.000Z') }
        : { endTime: new Date('2026-06-13T23:59:59.999Z') };
    repository.findMemoryAnalysisReport.mockResolvedValue(scenario === 'missing' ? null : createReport(overrides));
    await expect(runner.generateReport(reportContext, 1, range)).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledWith(reportApiKeyFingerprint, 1);
    expect(repository.updateMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(source.fetchSessionMemories).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it.each([
    { rawApiKey: 'other-key' },
    { apiKeyFingerprint: Buffer.alloc(32, 9) },
    { apiKeyFingerprint: Buffer.alloc(1) },
    { apiKeyFingerprintHex: Buffer.alloc(32, 9).toString('hex') },
  ])('rejects a forged context before any report write', async (override) => {
    const { source, repository, runner, range } = setupIsolatedReport();
    await expect(runner.generateReport({ ...reportContext, ...override }, 1, range)).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(repository.updateMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(source.fetchSessionMemories).not.toHaveBeenCalled();
  });

  it.each(['success', 'fail'])('leaves a terminal %s report unchanged on replay', async (renderStatus) => {
    const { source, repository, runner, range } = setupIsolatedReport();
    repository.findMemoryAnalysisReport.mockResolvedValue(createReport({ renderStatus }));
    await runner.generateReport(reportContext, 1, range);
    expect(repository.updateMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(source.fetchSessionMemories).not.toHaveBeenCalled();
  });

  it('rejects invalid dates before writing the running or failed state', async () => {
    const { source, repository, runner, range } = setupIsolatedReport();
    await expect(runner.generateReport(reportContext, 1, { ...range, createdAfter: 'invalid' }))
      .rejects.toMatchObject({ code: 'MEMORY_ANALYSIS_INVALID_DATE_RANGE' });
    expect(repository.updateMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(source.fetchSessionMemories).not.toHaveBeenCalled();
  });

  it('keeps the owner predicate when recording an initial update failure', async () => {
    const { source, repository, runner, range } = setupIsolatedReport();
    repository.updateMemoryAnalysisReport.mockRejectedValueOnce(new Error('initial update failed'));
    await runner.generateReport(reportContext, 1, range);
    expect(repository.updateMemoryAnalysisReport).toHaveBeenCalledTimes(2);
    expect(repository.updateMemoryAnalysisReport).toHaveBeenLastCalledWith(1, reportApiKeyFingerprint, expect.objectContaining({
      renderStatus: 'fail', failCode: 'MEMORY_ANALYSIS_GENERATION_FAILED',
    }));
    for (const [reportId, fingerprint] of repository.updateMemoryAnalysisReport.mock.calls) {
      expect(reportId).toBe(1);
      expect(fingerprint).toEqual(reportApiKeyFingerprint);
    }
    expect(source.fetchSessionMemories).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new SyntaxError('Response body contains space-key'),
      expectedCode: 'MEMORY_ANALYSIS_GENERATION_FAILED',
      expectedAttempts: 3,
    },
    {
      error: new AppError('Provider echoed space-key', {
        statusCode: 502,
        code: 'QWEN_REQUEST_FAILED',
        details: { rawApiKey: 'space-key' },
        cause: new Error('Nested space-key'),
      }),
      expectedCode: 'QWEN_REQUEST_FAILED',
      expectedAttempts: 3,
    },
    {
      error: new AppError('Provider echoed space-key', {
        statusCode: 502,
        code: 'provider-code-containing-space-key',
      }),
      expectedCode: 'MEMORY_ANALYSIS_GENERATION_FAILED',
      expectedAttempts: 1,
    },
  ])('keeps credentials out of failure logs and stored failure metadata without changing retries ($expectedCode, $expectedAttempts attempts)', async ({ error, expectedCode, expectedAttempts }) => {
    const { source, repository, runner, range } = setupIsolatedReport();
    error.stack = 'Original error stack containing space-key';
    source.fetchSessionMemories.mockRejectedValue(error);
    jest.spyOn(runner as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Test-only access to the private logger.
    const errorSpy = jest.spyOn(runner['logger'], 'error').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Test-only access to the private logger.
    const warnSpy = jest.spyOn(runner['logger'], 'warn').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Test-only access to the private logger.
    const logSpy = jest.spyOn(runner['logger'], 'log').mockImplementation(() => undefined);

    await runner.generateReport(reportContext, 1, range);

    expect(source.fetchSessionMemories).toHaveBeenCalledTimes(expectedAttempts);
    expect(repository.updateMemoryAnalysisReport).toHaveBeenLastCalledWith(1, reportApiKeyFingerprint, expect.objectContaining({
      renderStatus: 'fail', failCode: expectedCode,
    }));
    expect(JSON.stringify(repository.updateMemoryAnalysisReport.mock.calls)).not.toContain('space-key');
    expect(JSON.stringify([errorSpy.mock.calls, warnSpy.mock.calls, logSpy.mock.calls])).not.toContain('space-key');
    for (const call of errorSpy.mock.calls) expect(call).toHaveLength(1);
    const failure: unknown = JSON.parse(errorSpy.mock.calls.at(-1)![0] as string);
    expect(failure).toMatchObject({ event: 'memory_analysis_report_failed', failCode: expectedCode });
    expect(failure).not.toHaveProperty('stack');
    expect(failure).not.toHaveProperty('cause');
  });

  it('does not log or propagate a provider transport error containing credentials', async () => {
    const config = {
      ...TEST_CONFIG,
      analysis: {
        ...TEST_CONFIG.analysis,
        qwenApiBaseUrl: 'https://example.invalid/v1',
        qwenRequestTimeoutMs: 1000,
      },
    };
    const runner = new MemoryAnalysisReportRunnerService(config, {} as never, {} as never, new FakeRedis() as never);
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Transport error echoed space-key and test-qwen-key'));
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Test-only access to the private logger.
    const warnSpy = jest.spyOn(runner['logger'], 'warn').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Exercise the private transport boundary in isolation.
    const error = await runner['callQwenJsonCompletion']({
      event: 'memory_analysis_qwen_completed',
      systemPrompt: 'synthetic prompt',
      userContent: 'synthetic content',
      logMetadata: { reportId: 1 },
      timeoutLogMessage: 'Qwen request timed out',
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ message: 'Qwen request failed before completion', code: 'QWEN_REQUEST_FAILED' });
    expect(warnSpy.mock.calls).toMatchInlineSnapshot(`
[
  [
    "Qwen request failed before completion",
  ],
]
`);
    expect((error as AppError).cause).toBeUndefined();
    expect((error as AppError).stack).not.toContain('space-key');
    expect((error as AppError).stack).not.toContain('test-qwen-key');
  });

  it('uses the cache version for period summary cache lookups and writes', async () => {
    const source = {
      fetchSessionMemories: jest.fn(async () => [
        {
          id: 'turn-1',
          content: '今天开始准备法考，晚上复盘学习计划。',
          createdAt: '2026-06-22T08:05:03Z',
          memoryType: 'session',
          metadata: {},
        },
      ]),
    };
    const repository = {};
    const redis = new FakeRedis();
    const runner = new MemoryAnalysisReportRunnerService(
      TEST_CONFIG,
      source as never,
      repository as never,
      redis as never,
    );
    const qwenService = runner as unknown as {
      callQwenForPeriodSummaries: () => Promise<string>;
      callQwenForChangeAggregation: () => Promise<string>;
    };
    jest.spyOn(qwenService, 'callQwenForPeriodSummaries').mockResolvedValue(JSON.stringify({
      periods: [
        {
          periodKey: '2026-06-22',
          dimensions: [
            {
              dimension: 'long_term_goal',
              insights: [
                {
                  title: '法考准备',
                  summary: '用户开始准备法考并复盘学习计划。',
                  evidence: [{ evidenceId: 'turn-1', quote: '开始准备法考' }],
                },
              ],
            },
          ],
        },
      ],
    }));
    jest.spyOn(qwenService, 'callQwenForChangeAggregation').mockResolvedValue(JSON.stringify({
      d: [
        {
          k: 'long_term_goal',
          s: '用户围绕法考形成学习计划。',
          c: [
            {
              t: '法考准备',
              s: '用户开始准备法考并复盘学习计划。',
              p: { s: '2026-06-22T00:00:00Z', e: '2026-06-22T23:59:59Z' },
              e: ['turn-1'],
            },
          ],
        },
      ],
    }));

    await runner.analyzeSource(reportContext, {
      createdAfter: '2026-06-22T00:00:00Z',
      createdBefore: '2026-06-22T23:59:59Z',
    });

    const expectedCacheKey = `ma:period:${reportApiKeyFingerprint.toString('hex')}:2026-06-22:test-model:${MEMORY_PERIOD_SUMMARY_CACHE_VERSION}`;
    const expectedIndexKey = `ma:period:index:${reportApiKeyFingerprint.toString('hex')}:2026-06-22`;
    expect(redis.get).toHaveBeenCalledWith(expectedCacheKey);
    expect(redis.set).toHaveBeenCalledWith(
      expectedCacheKey,
      expect.any(String),
      'EX',
      2592000,
    );
    expect(redis.sadd).toHaveBeenCalledWith(expectedIndexKey, expectedCacheKey);
    expect(redis.expire).toHaveBeenCalledWith(expectedIndexKey, 2592000);
  });

  it('uses cached Redis period summaries without calling Qwen for the period pass', async () => {
    const source = {
      fetchSessionMemories: jest.fn(async () => [
        {
          id: 'turn-1',
          content: '今天继续准备法考。',
          createdAt: '2026-06-22T08:05:03Z',
          memoryType: 'session',
          metadata: {},
        },
      ]),
    };
    const redis = new FakeRedis();
    const cacheKey = `ma:period:${reportApiKeyFingerprint.toString('hex')}:2026-06-22:test-model:${MEMORY_PERIOD_SUMMARY_CACHE_VERSION}`;
    redis.values.set(cacheKey, JSON.stringify({
      periodKey: '2026-06-22',
      dimensions: [
        {
          dimension: 'long_term_goal',
          insights: [
            {
              title: '法考准备',
              summary: '用户持续准备法考。',
              evidence: [{ evidenceId: 'turn-1', quote: '继续准备法考' }],
            },
          ],
        },
      ],
    }));
    const runner = new MemoryAnalysisReportRunnerService(
      TEST_CONFIG,
      source as never,
      {} as never,
      redis as never,
    );
    const qwenService = runner as unknown as {
      callQwenForPeriodSummaries: () => Promise<string>;
      callQwenForChangeAggregation: () => Promise<string>;
    };
    const periodSpy = jest.spyOn(qwenService, 'callQwenForPeriodSummaries');
    jest.spyOn(qwenService, 'callQwenForChangeAggregation').mockResolvedValue(JSON.stringify({
      d: [
        {
          k: 'long_term_goal',
          s: '用户持续围绕法考推进准备。',
          c: [
            {
              t: '法考准备',
              s: '用户持续准备法考。',
              p: { s: '2026-06-22T00:00:00Z', e: '2026-06-22T23:59:59Z' },
              e: ['turn-1'],
            },
          ],
        },
      ],
    }));

    await runner.analyzeSource(reportContext, {
      createdAfter: '2026-06-22T00:00:00Z',
      createdBefore: '2026-06-22T23:59:59Z',
    });

    expect(redis.get).toHaveBeenCalledWith(cacheKey);
    expect(periodSpy).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
