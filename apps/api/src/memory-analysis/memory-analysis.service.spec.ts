import type { AppConfig } from '@mem9/config';

import { MemoryAnalysisService } from './memory-analysis.service';

const reportApiKeyFingerprint = Buffer.alloc(32, 1);
const reportContext = {
  apiKeyFingerprint: reportApiKeyFingerprint,
} as never;

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
    templateId: 'focus_area',
    reportContent: '{"summary":"ok"}',
    generatedAt: new Date('2026-06-26T08:00:00.000Z'),
    startTime: new Date('2026-06-01T00:00:00.000Z'),
    endTime: new Date('2026-06-14T23:59:59.999Z'),
    renderStatus: 'success',
    failReason: null,
    memoryCount: 12,
    ...overrides,
  };
}

function createReportService(repository: Record<string, jest.Mock>) {
  return new MemoryAnalysisService(
    { analysis: {} } as never,
    {} as never,
    repository as never,
  );
}

function createSessionContext() {
  const apiKeyFingerprint = Buffer.alloc(32, 9);
  return {
    apiKeyFingerprint,
    apiKeyFingerprintHex: apiKeyFingerprint.toString('hex'),
    rawApiKey: 'space-key',
    requestId: 'req_1',
  };
}

function createSessionService(overrides?: {
  source?: Record<string, unknown>;
  repository?: Record<string, unknown>;
}) {
  const source = {
    markSessionMessage: jest.fn(async () => ({
      id: 'turn-1',
      correctness: 'correct',
      version: 1,
    })),
    editSessionMessage: jest.fn(async () => ({
      id: 'turn-1',
      editId: 'turn-1',
      version: 2,
      correctness: 'correct',
      originalContent: 'original',
      editedContent: 'corrected',
      tags: ['tag-a'],
      session: {
        id: 'turn-1',
        content: 'corrected',
        createdAt: '2026-06-27T12:34:56Z',
        memoryType: 'session',
        tags: ['tag-a'],
        metadata: { edited: true },
      },
    })),
    getSessionMessageEdit: jest.fn(async () => ({
      id: 'turn-1',
      version: 2,
      correctness: 'correct',
      originalContent: 'original',
      editedContent: 'corrected',
    })),
    fetchMemoryById: jest.fn(async () => ({
      id: 'turn-1',
      content: 'corrected',
      createdAt: '2026-06-27T12:34:56Z',
    })),
    deleteSessionMessageEdit: jest.fn(async () => ({
      id: 'turn-1',
      reverted: true,
    })),
    fetchSessionMemories: jest.fn(async () => []),
    ...overrides?.source,
  };
  const repository = {
    invalidateMemoryAnalysisPeriodCache: jest.fn(async () => 1),
    findMemoryAnalysisPeriodCache: jest.fn(async () => null),
    upsertMemoryAnalysisPeriodCache: jest.fn(async () => undefined),
    ...overrides?.repository,
  };

  return {
    source,
    repository,
    service: new MemoryAnalysisService(
      TEST_CONFIG,
      source as never,
      repository as never,
    ),
  };
}

describe('memory analysis report service', () => {
  it('creates memory analysis reports in the memory_report table', async () => {
    const repository = {
      createMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const service = createReportService(repository);

    const response = await service.createReport(reportContext, {
      template_id: 'focus_area',
      report_content: '{"summary":"ok"}',
      startTime: '2026-06-01T00:00:00.000Z',
      endTime: '2026-06-14T23:59:59.999Z',
      render_status: 'success',
      fail_reason: '',
      memory_count: 12,
    });

    expect(repository.createMemoryAnalysisReport).toHaveBeenCalledWith({
      fingerprint: reportApiKeyFingerprint,
      templateId: 'focus_area',
      reportContent: '{"summary":"ok"}',
      startTime: new Date('2026-06-01T00:00:00.000Z'),
      endTime: new Date('2026-06-14T23:59:59.999Z'),
      renderStatus: 'success',
      failReason: '',
      memoryCount: 12,
    });
    expect(response).toEqual({
      report_id: 1,
      template_id: 'focus_area',
      report_content: '{"summary":"ok"}',
      generated_at: '2026-06-26T08:00:00.000Z',
      startTime: '2026-06-01T00:00:00.000Z',
      endTime: '2026-06-14T23:59:59.999Z',
      render_status: 'success',
      fail_reason: null,
      memory_count: 12,
    });
  });

  it('lists memory analysis reports by type', async () => {
    const repository = {
      listMemoryAnalysisReportsByTemplateId: jest.fn(async () => [
        createReport({ reportId: 2, templateId: 'preference_signal', renderStatus: 'fail', failReason: 'bad json' }),
      ]),
    };
    const service = createReportService(repository);

    const response = await service.listReports(reportContext, { type: 'preference_signal' });

    expect(repository.listMemoryAnalysisReportsByTemplateId).toHaveBeenCalledWith(
      reportApiKeyFingerprint,
      'preference_signal',
    );
    expect(response).toEqual([
      {
        report_id: 2,
        template_id: 'preference_signal',
        report_content: '{"summary":"ok"}',
        generated_at: '2026-06-26T08:00:00.000Z',
        startTime: '2026-06-01T00:00:00.000Z',
        endTime: '2026-06-14T23:59:59.999Z',
        render_status: 'fail',
        fail_reason: 'bad json',
        memory_count: 12,
      },
    ]);
  });

  it('gets one memory analysis report by report_id', async () => {
    const repository = {
      findMemoryAnalysisReport: jest.fn(async () => createReport({ reportId: 3 })),
    };
    const service = createReportService(repository);

    const response = await service.getReport(reportContext, '3');

    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledWith(reportApiKeyFingerprint, 3);
    expect(response?.report_id).toBe(3);
  });

  it('returns null when a memory analysis report is missing or report_id is invalid', async () => {
    const repository = {
      findMemoryAnalysisReport: jest.fn(async () => null),
    };
    const service = createReportService(repository);

    await expect(service.getReport(reportContext, '4')).resolves.toBeNull();
    await expect(service.getReport(reportContext, 'not-a-number')).resolves.toBeNull();
    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledTimes(1);
  });
});

describe('memory analysis session message operations', () => {
  it('marks session messages and invalidates the source day cache', async () => {
    const { service, source, repository } = createSessionService();

    const result = await service.markSessionMessage(createSessionContext(), 'turn-1', 'correct');

    expect(result).toEqual({
      id: 'turn-1',
      correctness: 'correct',
      version: 1,
    });
    expect(source.fetchMemoryById).toHaveBeenCalledWith('space-key', 'turn-1');
    expect(source.markSessionMessage).toHaveBeenCalledWith('space-key', 'turn-1', 'correct');
    expect(repository.invalidateMemoryAnalysisPeriodCache).toHaveBeenCalledWith({
      fingerprint: createSessionContext().apiKeyFingerprint,
      periodKey: '2026-06-27',
    });
  });

  it('rejects invalid mark values before calling mem9 server', async () => {
    const { service, source } = createSessionService();

    await expect(
      service.markSessionMessage(createSessionContext(), 'turn-1', 'bogus'),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'SESSION_MESSAGE_MARK_INVALID',
    });

    expect(source.markSessionMessage).not.toHaveBeenCalled();
  });

  it('edits session messages and invalidates the source day cache', async () => {
    const { service, repository } = createSessionService();

    const result = await service.editSessionMessage(createSessionContext(), 'turn-1', {
      content: 'corrected',
      tags: ['tag-a'],
    });

    expect(result.invalidatedPeriodKey).toBe('2026-06-27');
    expect(repository.invalidateMemoryAnalysisPeriodCache).toHaveBeenCalledWith({
      fingerprint: createSessionContext().apiKeyFingerprint,
      periodKey: '2026-06-27',
    });
  });

  it('rejects empty edit content before calling mem9 server', async () => {
    const { service, source } = createSessionService();

    await expect(
      service.editSessionMessage(createSessionContext(), 'turn-1', {
        content: '   ',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'SESSION_MESSAGE_EDIT_CONTENT_REQUIRED',
    });

    expect(source.editSessionMessage).not.toHaveBeenCalled();
  });

  it('loads the session timestamp before deleting an edit and invalidates cache', async () => {
    const { service, source, repository } = createSessionService();

    const result = await service.deleteSessionMessageEdit(createSessionContext(), 'turn-1');

    expect(result).toEqual({
      id: 'turn-1',
      reverted: true,
      invalidatedPeriodKey: '2026-06-27',
    });
    expect(source.fetchMemoryById).toHaveBeenCalledWith('space-key', 'turn-1');
    expect(source.deleteSessionMessageEdit).toHaveBeenCalledWith('space-key', 'turn-1');
    expect(repository.invalidateMemoryAnalysisPeriodCache).toHaveBeenCalledWith({
      fingerprint: createSessionContext().apiKeyFingerprint,
      periodKey: '2026-06-27',
    });
  });

  it('includes session correction state on report evidence', async () => {
    const { service } = createSessionService({
      source: {
        fetchSessionMemories: jest.fn(async () => [
          {
            id: 'turn-edited',
            content: '我打算半年内打上lol国服王者，然后取EDG试训',
            createdAt: '2026-06-22T08:05:03Z',
            memoryType: 'session',
            metadata: {
              correctness: 'correct',
              edited: true,
              edit_version: 7,
              edited_at: '2026-06-27T10:17:52Z',
            },
          },
        ]),
      },
    });
    const qwenService = service as unknown as {
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
                  title: 'LOL 国服王者/EDG 试训',
                  summary: '用户计划在半年内达到 LOL 国服王者段位并尝试 EDG 试训。',
                  evidence: [
                    {
                      evidenceId: 'turn-edited',
                      quote: '我打算半年内打上lol国服王者，然后取EDG试训',
                    },
                  ],
                },
              ],
            },
            {
              dimension: 'emotion',
              insights: [
                {
                  title: '情绪平稳',
                  summary: '用户当前情绪整体平稳，但仍有轻微焦虑。',
                  evidence: [
                    {
                      evidenceId: 'turn-edited',
                      quote: '我打算半年内打上lol国服王者，然后取EDG试训',
                    },
                  ],
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
          s: '用户当前围绕 LOL 段位和职业试训形成明确长期目标。',
          c: [
            {
              t: 'LOL 国服王者/EDG 试训',
              s: '用户计划在半年内达到 LOL 国服王者段位并尝试 EDG 试训。',
              score: 9,
              p: { s: '2026-06-22T00:00:00Z', e: '2026-06-22T23:59:59Z' },
              e: ['turn-edited'],
            },
          ],
        },
        {
          k: 'emotion',
          s: '用户当前情绪整体平稳，但仍有轻微焦虑。',
          c: [
            {
              t: '情绪平稳',
              s: '用户当前情绪整体平稳，但仍有轻微焦虑。',
              score: 6,
              p: { s: '2026-06-22T00:00:00Z', e: '2026-06-22T23:59:59Z' },
              e: ['turn-edited'],
            },
          ],
        },
      ],
    }));

    const result = await service.analyzeSource(createSessionContext(), {
      createdAfter: '2026-06-22T00:00:00Z',
      createdBefore: '2026-06-22T23:59:59Z',
    });

    expect(result.dimensions[0]?.summary).toBe('用户当前围绕 LOL 段位和职业试训形成明确长期目标。');
    expect(result.dimensions[0]?.changes[0]?.score).toBeUndefined();
    expect(result.dimensions[1]?.dimension).toBe('emotion');
    expect(result.dimensions[1]?.summary).toBe('用户当前情绪整体平稳，但仍有轻微焦虑。');
    expect(result.dimensions[1]?.changes[0]?.score).toBe(6);
    expect(result.dimensions[0]?.changes[0]?.evidence[0]).toEqual({
      evidenceId: 'turn-edited',
      quote: '我打算半年内打上lol国服王者，然后取EDG试训',
      review: {
        correctness: 'correct',
        edited: true,
        editVersion: 7,
        editedAt: '2026-06-27T10:17:52Z',
      },
    });
  });
});
