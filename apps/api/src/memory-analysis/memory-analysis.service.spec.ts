import { MemoryAnalysisService } from './memory-analysis.service';

const reportApiKeyFingerprint = Buffer.alloc(32, 1);
const reportContext = {
  apiKeyFingerprint: reportApiKeyFingerprint,
  apiKeyFingerprintHex: reportApiKeyFingerprint.toString('hex'),
  rawApiKey: 'space-key',
  requestId: 'req_1',
} as never;

const TEST_CONFIG = {
  analysis: {
    qwenModel: 'test-model',
  },
} as never;

function createReport(overrides: Record<string, unknown> = {}) {
  return {
    reportId: 1,
    apiKeyFingerprint: reportApiKeyFingerprint,
    templateId: 'focus_area',
    reportContent: '{"summary":"ok"}',
    generatedAt: new Date('2026-06-26T08:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    startTime: new Date('2026-06-01T00:00:00.000Z'),
    endTime: new Date('2026-06-14T23:59:59.999Z'),
    renderStatus: 'success',
    reportStage: 'complete',
    failCode: null,
    failReason: null,
    memoryCount: 12,
    ...overrides,
  };
}

function createReportService(
  repository: Record<string, jest.Mock>,
  queue?: Record<string, jest.Mock>,
  sourceOverrides?: Record<string, jest.Mock>,
  redisOverrides?: Record<string, jest.Mock>,
) {
  return new MemoryAnalysisService(
    {
      fetchSessionMemories: jest.fn(async () => []),
      countSessionMemories: jest.fn(async () => 101),
      ...sourceOverrides,
    } as never,
    repository as never,
    (queue ?? { enqueueLlmMessage: jest.fn(async () => undefined) }) as never,
    {
      smembers: jest.fn(async () => []),
      mget: jest.fn(async () => []),
      del: jest.fn(async () => 0),
      ...redisOverrides,
    } as never,
    TEST_CONFIG,
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
  redis?: Record<string, unknown>;
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
    ...overrides?.repository,
  };
  const redis = {
    smembers: jest.fn(async () => [
      `ma:period:${createSessionContext().apiKeyFingerprintHex}:2026-06-27:test-model:v1`,
    ]),
    del: jest.fn(async () => 2),
    ...overrides?.redis,
  };

  return {
    source,
    repository,
    redis,
    service: new MemoryAnalysisService(
      source as never,
      repository as never,
      { enqueueLlmMessage: jest.fn(async () => undefined) } as never,
      redis as never,
      TEST_CONFIG,
    ),
  };
}

describe('memory analysis report service', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates queued memory analysis report jobs', async () => {
    const repository = {
      findActiveMemoryAnalysisReportByDay: jest.fn(async () => null),
      countMemoryAnalysisReportsByDay: jest.fn(async () => 0),
      createMemoryAnalysisReport: jest.fn(async () => createReport({
        templateId: 'memory_analysis',
        reportContent: '',
        renderStatus: 'queued',
        reportStage: 'queued',
        memoryCount: 101,
      })),
      updateMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const queue = {
      enqueueLlmMessage: jest.fn(async () => undefined),
    };
    const service = createReportService(repository, queue);

    const response = await service.createReport(reportContext, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    });

    expect(repository.createMemoryAnalysisReport).toHaveBeenCalledWith({
      fingerprint: reportApiKeyFingerprint,
      templateId: 'memory_analysis',
      startTime: new Date('2026-06-01T00:00:00.000Z'),
      endTime: new Date('2026-06-14T23:59:59.999Z'),
      renderStatus: 'queued',
      reportStage: 'queued',
      memoryCount: 101,
    });
    expect(repository.findActiveMemoryAnalysisReportByDay).toHaveBeenCalledWith(expect.objectContaining({
      fingerprint: reportApiKeyFingerprint,
      templateId: 'memory_analysis',
    }));
    expect(repository.countMemoryAnalysisReportsByDay).toHaveBeenCalledWith(expect.objectContaining({
      fingerprint: reportApiKeyFingerprint,
      templateId: 'memory_analysis',
    }));
    expect(response).toEqual({
      report_id: 1,
      template_id: 'memory_analysis',
      report_content: null,
      generated_at: '2026-06-26T08:00:00.000Z',
      started_at: null,
      completed_at: null,
      startTime: '2026-06-01T00:00:00.000Z',
      endTime: '2026-06-14T23:59:59.999Z',
      render_status: 'queued',
      report_stage: 'queued',
      fail_code: null,
      fail_reason: null,
      memory_count: 101,
    });

    expect(queue.enqueueLlmMessage).toHaveBeenCalledWith({
      messageType: 'memory_analysis_report',
      reportId: 1,
      apiKeyFingerprintHex: reportApiKeyFingerprint.toString('hex'),
      rawApiKey: 'space-key',
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
      traceId: 'req_1',
    });
    expect(repository.updateMemoryAnalysisReport).not.toHaveBeenCalled();
  });

  it('checks only uncached period days against the processing memory limit', async () => {
    const repository = {
      findActiveMemoryAnalysisReportByDay: jest.fn(async () => null),
      countMemoryAnalysisReportsByDay: jest.fn(async () => 0),
      createMemoryAnalysisReport: jest.fn(async () => createReport({
        templateId: 'memory_analysis',
        reportContent: '',
        renderStatus: 'queued',
        reportStage: 'queued',
        memoryCount: 30001,
      })),
      updateMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const countSessionMemories = jest
      .fn()
      .mockResolvedValueOnce(30001)
      .mockResolvedValueOnce(15000);
    const mget = jest.fn(async () => [
      JSON.stringify({ periodKey: '2026-06-01' }),
      null,
    ]);
    const service = createReportService(
      repository,
      undefined,
      { countSessionMemories },
      { mget },
    );

    await service.createReport(reportContext, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-02T23:59:59.999Z',
    });

    expect(mget).toHaveBeenCalledWith(
      `ma:period:${reportApiKeyFingerprint.toString('hex')}:2026-06-01:test-model:v1`,
      `ma:period:${reportApiKeyFingerprint.toString('hex')}:2026-06-02:test-model:v1`,
    );
    expect(countSessionMemories).toHaveBeenCalledTimes(2);
    expect(countSessionMemories).toHaveBeenNthCalledWith(1, 'space-key', {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-02T23:59:59.999Z',
    });
    expect(countSessionMemories).toHaveBeenNthCalledWith(2, 'space-key', {
      createdAfter: '2026-06-02T00:00:00.000Z',
      createdBefore: '2026-06-02T23:59:59.999Z',
    });
    expect(repository.createMemoryAnalysisReport).toHaveBeenCalled();
  });

  it('rejects creating a report when another report is running for the same day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T08:00:00.000Z'));
    const repository = {
      findActiveMemoryAnalysisReportByDay: jest.fn(async () => createReport({
        reportId: 9,
        templateId: 'memory_analysis',
        reportContent: '',
        renderStatus: 'running',
        reportStage: 'period_summary',
        memoryCount: 0,
        generatedAt: new Date('2026-06-30T07:30:00.000Z'),
        startedAt: new Date('2026-06-30T07:30:00.000Z'),
      })),
      createMemoryAnalysisReport: jest.fn(),
      updateMemoryAnalysisReport: jest.fn(),
    };
    const service = createReportService(repository);

    await expect(service.createReport(reportContext, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEEP_ANALYSIS_ALREADY_RUNNING',
      details: {
        reportId: 9,
      },
    });

    expect(repository.createMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(repository.updateMemoryAnalysisReport).not.toHaveBeenCalled();
  });

  it('expires a stale queued report before creating a new one', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T08:00:00.000Z'));
    const repository = {
      findActiveMemoryAnalysisReportByDay: jest.fn(async () => createReport({
        reportId: 9,
        templateId: 'memory_analysis',
        reportContent: '',
        renderStatus: 'queued',
        reportStage: 'queued',
        memoryCount: 0,
        generatedAt: new Date('2026-06-30T07:49:59.000Z'),
      })),
      countMemoryAnalysisReportsByDay: jest.fn(async () => 1),
      createMemoryAnalysisReport: jest.fn(async () => createReport({
        reportId: 10,
        templateId: 'memory_analysis',
        reportContent: '',
        renderStatus: 'queued',
        reportStage: 'queued',
        memoryCount: 101,
      })),
      updateMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const service = createReportService(repository);

    const response = await service.createReport(reportContext, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    });

    expect(response.report_id).toBe(10);
    expect(repository.updateMemoryAnalysisReport).toHaveBeenCalledWith(9, expect.objectContaining({
      renderStatus: 'fail',
      reportStage: 'failed',
      failCode: 'MEMORY_ANALYSIS_REPORT_EXPIRED',
    }));
    expect(repository.createMemoryAnalysisReport).toHaveBeenCalled();
  });

  it('expires a stale running report before creating a new one', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T08:00:00.000Z'));
    const repository = {
      findActiveMemoryAnalysisReportByDay: jest.fn(async () => createReport({
        reportId: 9,
        templateId: 'memory_analysis',
        reportContent: '',
        renderStatus: 'running',
        reportStage: 'period_summary',
        memoryCount: 0,
        generatedAt: new Date('2026-06-30T06:59:59.000Z'),
        startedAt: new Date('2026-06-30T06:59:59.000Z'),
      })),
      countMemoryAnalysisReportsByDay: jest.fn(async () => 1),
      createMemoryAnalysisReport: jest.fn(async () => createReport({
        reportId: 10,
        templateId: 'memory_analysis',
        reportContent: '',
        renderStatus: 'queued',
        reportStage: 'queued',
        memoryCount: 101,
      })),
      updateMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const service = createReportService(repository);

    const response = await service.createReport(reportContext, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    });

    expect(response.report_id).toBe(10);
    expect(repository.updateMemoryAnalysisReport).toHaveBeenCalledWith(9, expect.objectContaining({
      renderStatus: 'fail',
      reportStage: 'failed',
      failCode: 'MEMORY_ANALYSIS_REPORT_EXPIRED',
    }));
    expect(repository.createMemoryAnalysisReport).toHaveBeenCalled();
  });

  it('rejects the eleventh memory analysis report for the same day', async () => {
    const repository = {
      findActiveMemoryAnalysisReportByDay: jest.fn(async () => null),
      countMemoryAnalysisReportsByDay: jest.fn(async () => 10),
      createMemoryAnalysisReport: jest.fn(),
    };
    const service = createReportService(repository);

    await expect(service.createReport(reportContext, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEEP_ANALYSIS_DAILY_LIMIT',
      details: {
        maximumPerDay: 10,
      },
    });

    expect(repository.createMemoryAnalysisReport).not.toHaveBeenCalled();
  });

  it('rejects memory analysis report creation when the source window is too large', async () => {
    const repository = {
      findActiveMemoryAnalysisReportByDay: jest.fn(async () => null),
      countMemoryAnalysisReportsByDay: jest.fn(async () => 0),
      createMemoryAnalysisReport: jest.fn(),
    };
    const service = createReportService(
      repository,
      undefined,
      {
        countSessionMemories: jest
          .fn()
          .mockResolvedValueOnce(30001)
          .mockResolvedValueOnce(20001),
      },
    );

    await expect(service.createReport(reportContext, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'DEEP_ANALYSIS_TOO_MANY_MEMORIES',
      details: {
        memoryCount: 20001,
        maximum: 20000,
      },
    });

    expect(repository.createMemoryAnalysisReport).not.toHaveBeenCalled();
  });

  it('marks the report failed when queueing generation fails', async () => {
    const repository = {
      findActiveMemoryAnalysisReportByDay: jest.fn(async () => null),
      countMemoryAnalysisReportsByDay: jest.fn(async () => 0),
      createMemoryAnalysisReport: jest.fn(async () => createReport({
        templateId: 'memory_analysis',
        reportContent: '',
        renderStatus: 'queued',
        reportStage: 'queued',
        memoryCount: 0,
      })),
      updateMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const service = createReportService(repository, {
      enqueueLlmMessage: jest.fn(async () => {
        throw new Error('sqs down');
      }),
    });
    const errorSpy = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);

    await expect(service.createReport(reportContext, {
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
    })).rejects.toMatchObject({
      code: 'MEMORY_ANALYSIS_QUEUE_ENQUEUE_FAILED',
    });

    expect(repository.updateMemoryAnalysisReport).toHaveBeenCalledWith(1, expect.objectContaining({
      renderStatus: 'fail',
      reportStage: 'failed',
      failCode: 'MEMORY_ANALYSIS_QUEUE_ENQUEUE_FAILED',
    }));
    expect(errorSpy).toHaveBeenCalled();
  });

  it('lists memory analysis reports by type', async () => {
    const repository = {
      listMemoryAnalysisReportsByTemplateId: jest.fn(async () => [
        createReport({
          reportId: 2,
          templateId: 'preference_signal',
          renderStatus: 'fail',
          reportStage: 'failed',
          failCode: 'MEMORY_ANALYSIS_GENERATION_FAILED',
          failReason: 'bad json',
        }),
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
        report_content: null,
        generated_at: '2026-06-26T08:00:00.000Z',
        started_at: null,
        completed_at: null,
        startTime: '2026-06-01T00:00:00.000Z',
        endTime: '2026-06-14T23:59:59.999Z',
        render_status: 'fail',
        report_stage: 'failed',
        fail_code: 'MEMORY_ANALYSIS_GENERATION_FAILED',
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
    const { service, source, redis } = createSessionService();

    const result = await service.markSessionMessage(createSessionContext(), 'turn-1', 'correct');

    expect(result).toEqual({
      id: 'turn-1',
      correctness: 'correct',
      version: 1,
    });
    expect(source.fetchMemoryById).toHaveBeenCalledWith('space-key', 'turn-1');
    expect(source.markSessionMessage).toHaveBeenCalledWith('space-key', 'turn-1', 'correct');
    expect(redis.smembers).toHaveBeenCalledWith(
      `ma:period:index:${createSessionContext().apiKeyFingerprintHex}:2026-06-27`,
    );
    expect(redis.del).toHaveBeenCalledWith(
      `ma:period:${createSessionContext().apiKeyFingerprintHex}:2026-06-27:test-model:v1`,
      `ma:period:index:${createSessionContext().apiKeyFingerprintHex}:2026-06-27`,
    );
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
    const { service, redis } = createSessionService();

    const result = await service.editSessionMessage(createSessionContext(), 'turn-1', {
      content: 'corrected',
      tags: ['tag-a'],
    });

    expect(result.invalidatedPeriodKey).toBe('2026-06-27');
    expect(redis.smembers).toHaveBeenCalledWith(
      `ma:period:index:${createSessionContext().apiKeyFingerprintHex}:2026-06-27`,
    );
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
    const { service, source, redis } = createSessionService();

    const result = await service.deleteSessionMessageEdit(createSessionContext(), 'turn-1');

    expect(result).toEqual({
      id: 'turn-1',
      reverted: true,
      invalidatedPeriodKey: '2026-06-27',
    });
    expect(source.fetchMemoryById).toHaveBeenCalledWith('space-key', 'turn-1');
    expect(source.deleteSessionMessageEdit).toHaveBeenCalledWith('space-key', 'turn-1');
    expect(redis.smembers).toHaveBeenCalledWith(
      `ma:period:index:${createSessionContext().apiKeyFingerprintHex}:2026-06-27`,
    );
  });

});
