import type { AppConfig } from '@mem9/config';

import { MemoryAnalysisService } from './memory-analysis.service';

const reportApiKeyFingerprint = Buffer.alloc(32, 1);
const reportContext = {
  apiKeyFingerprint: reportApiKeyFingerprint,
} as never;

const TEST_CONFIG = {
  analysis: {
    qwenModel: 'test-model',
  },
} as AppConfig;

function createReport(overrides: Record<string, unknown> = {}) {
  return {
    reportId: 1,
    apiKeyFingerprint: reportApiKeyFingerprint,
    templateId: 'focus_area',
    reportContent: '{"summary":"ok"}',
    generatedAt: new Date('2026-06-26T08:00:00.000Z'),
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
    ...overrides?.source,
  };
  const repository = {
    invalidateMemoryAnalysisPeriodCache: jest.fn(async () => 1),
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
      render_status: 'success',
      fail_reason: '',
      memory_count: 12,
    });

    expect(repository.createMemoryAnalysisReport).toHaveBeenCalledWith({
      fingerprint: reportApiKeyFingerprint,
      templateId: 'focus_area',
      reportContent: '{"summary":"ok"}',
      renderStatus: 'success',
      failReason: '',
      memoryCount: 12,
    });
    expect(response).toEqual({
      report_id: 1,
      template_id: 'focus_area',
      report_content: '{"summary":"ok"}',
      generated_at: '2026-06-26T08:00:00.000Z',
      render_status: 'success',
      fail_reason: null,
      memory_count: 12,
    });
  });

  it('lists memory analysis reports by type', async () => {
    const repository = {
      listMemoryAnalysisReportsByTemplateId: jest.fn(async () => [
        createReport({ reportId: 2, templateId: 'emotion', renderStatus: 'fail', failReason: 'bad json' }),
      ]),
    };
    const service = createReportService(repository);

    const response = await service.listReports(reportContext, { type: 'emotion' });

    expect(repository.listMemoryAnalysisReportsByTemplateId).toHaveBeenCalledWith(
      reportApiKeyFingerprint,
      'emotion',
    );
    expect(response).toEqual([
      {
        report_id: 2,
        template_id: 'emotion',
        report_content: '{"summary":"ok"}',
        generated_at: '2026-06-26T08:00:00.000Z',
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
});
