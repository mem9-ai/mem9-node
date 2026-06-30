import type { AppConfig } from '@mem9/config';

import { MEMORY_PERIOD_SUMMARY_CACHE_VERSION } from './memory-analysis/prompts';
import { MemoryAnalysisReportRunnerService } from './memory-analysis-report-runner.service';

const reportApiKeyFingerprint = Buffer.alloc(32, 1);
const reportContext = {
  apiKeyFingerprint: reportApiKeyFingerprint,
  apiKeyFingerprintHex: reportApiKeyFingerprint.toString('hex'),
  rawApiKey: 'space-key',
  requestId: 'req_1',
};

const TEST_CONFIG = {
  analysis: {
    qwenModel: 'test-model',
    qwenApiKey: 'test-qwen-key',
  },
} as AppConfig;

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
  it('retries transient report generation failures before marking success', async () => {
    const source = {
      fetchSessionMemories: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary source failure'))
        .mockResolvedValue([]),
    };
    const repository = {
      updateMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const runner = new MemoryAnalysisReportRunnerService(
      { analysis: {} } as never,
      source as never,
      repository as never,
    );

    await runner.generateReport(reportContext, 1, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    });

    expect(source.fetchSessionMemories).toHaveBeenCalledTimes(2);
    expect(repository.updateMemoryAnalysisReport).toHaveBeenLastCalledWith(1, expect.objectContaining({
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
      updateMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const runner = new MemoryAnalysisReportRunnerService(
      { analysis: {} } as never,
      source as never,
      repository as never,
    );

    await runner.generateReport(reportContext, 1, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    });

    expect(repository.updateMemoryAnalysisReport).toHaveBeenLastCalledWith(1, expect.objectContaining({
      renderStatus: 'fail',
      reportStage: 'failed',
      failCode: 'QWEN_NOT_CONFIGURED',
      failReason: 'Qwen API key or model is not configured.',
    }));
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
    const repository = {
      findMemoryAnalysisPeriodCache: jest.fn(async () => null),
      upsertMemoryAnalysisPeriodCache: jest.fn(async () => undefined),
    };
    const runner = new MemoryAnalysisReportRunnerService(
      TEST_CONFIG,
      source as never,
      repository as never,
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

    expect(repository.findMemoryAnalysisPeriodCache).toHaveBeenCalledWith({
      fingerprint: reportApiKeyFingerprint,
      periodKey: '2026-06-22',
      model: 'test-model',
      promptVersion: MEMORY_PERIOD_SUMMARY_CACHE_VERSION,
    });
    expect(repository.upsertMemoryAnalysisPeriodCache).toHaveBeenCalledWith(expect.objectContaining({
      fingerprint: reportApiKeyFingerprint,
      periodKey: '2026-06-22',
      model: 'test-model',
      promptVersion: MEMORY_PERIOD_SUMMARY_CACHE_VERSION,
    }));
  });
});
