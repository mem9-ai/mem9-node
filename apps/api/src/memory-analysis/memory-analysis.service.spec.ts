import { MemoryAnalysisService } from './memory-analysis.service';

function createReport(overrides: Record<string, unknown> = {}) {
  return {
    reportId: 1,
    templateId: 'focus_area',
    reportContent: '{"summary":"ok"}',
    generatedAt: new Date('2026-06-26T08:00:00.000Z'),
    renderStatus: 'success',
    failReason: null,
    memoryCount: 12,
    ...overrides,
  };
}

function createService(repository: Record<string, jest.Mock>) {
  return new MemoryAnalysisService(
    { analysis: {} } as never,
    {} as never,
    repository as never,
  );
}

describe('memory analysis report service', () => {
  it('creates memory analysis reports in the memory_report table', async () => {
    const repository = {
      createMemoryAnalysisReport: jest.fn(async () => createReport()),
    };
    const service = createService(repository);

    const response = await service.createReport({
      template_id: 'focus_area',
      report_content: '{"summary":"ok"}',
      render_status: 'success',
      fail_reason: '',
      memory_count: 12,
    });

    expect(repository.createMemoryAnalysisReport).toHaveBeenCalledWith({
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
    const service = createService(repository);

    const response = await service.listReports({ type: 'emotion' });

    expect(repository.listMemoryAnalysisReportsByTemplateId).toHaveBeenCalledWith('emotion');
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
    const service = createService(repository);

    const response = await service.getReport('3');

    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledWith(3);
    expect(response?.report_id).toBe(3);
  });

  it('returns null when a memory analysis report is missing or report_id is invalid', async () => {
    const repository = {
      findMemoryAnalysisReport: jest.fn(async () => null),
    };
    const service = createService(repository);

    await expect(service.getReport('4')).resolves.toBeNull();
    await expect(service.getReport('not-a-number')).resolves.toBeNull();
    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledTimes(1);
  });
});
