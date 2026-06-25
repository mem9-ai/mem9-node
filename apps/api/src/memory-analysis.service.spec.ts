import { MemoryAnalysisService } from './memory-analysis.service';

describe('memory analysis service reports', () => {
  function createService() {
    const repository = {
      createReport: jest.fn(async () => ({
        reportId: 1,
        templateId: 'emotion_trend_v1',
        reportContent: '{"summary":"ok"}',
        generatedAt: new Date('2026-06-25T08:00:00Z'),
        renderStatus: 'success',
        failReason: '',
      })),
      findReport: jest.fn(async (reportId: number) =>
        reportId === 1
          ? {
              reportId: 1,
              templateId: 'emotion_trend_v1',
              reportContent: '{"summary":"ok"}',
              generatedAt: new Date('2026-06-25T08:00:00Z'),
              renderStatus: 'success',
              failReason: '',
            }
          : null),
      listReportsByTemplateId: jest.fn(async (templateId: string) => [
        {
          reportId: 2,
          templateId,
          reportContent: '{"summary":"focus"}',
          generatedAt: new Date('2026-06-25T09:00:00Z'),
          renderStatus: 'success',
          failReason: '',
        },
      ]),
    };

    return {
      repository,
      service: new MemoryAnalysisService(
        { analysis: { qwenModel: 'test-model' } } as never,
        {} as never,
        repository as never,
      ),
    };
  }

  it('creates a report in the reports table shape', async () => {
    const { repository, service } = createService();

    const response = await service.createReport({
      template_id: 'emotion_trend_v1',
      report_content: '{"summary":"ok"}',
      render_status: 'success',
    });

    expect(repository.createReport).toHaveBeenCalledWith({
      templateId: 'emotion_trend_v1',
      reportContent: '{"summary":"ok"}',
      renderStatus: 'success',
      failReason: '',
    });
    expect(response).toEqual({
      report_id: 1,
      template_id: 'emotion_trend_v1',
      report_content: '{"summary":"ok"}',
      generated_at: '2026-06-25T08:00:00.000Z',
      render_status: 'success',
      fail_reason: '',
    });
  });

  it('gets an existing report by auto-increment id', async () => {
    const { service } = createService();

    await expect(service.getReport('1')).resolves.toEqual({
      report_id: 1,
      template_id: 'emotion_trend_v1',
      report_content: '{"summary":"ok"}',
      generated_at: '2026-06-25T08:00:00.000Z',
      render_status: 'success',
      fail_reason: '',
    });
  });

  it('returns null when a report does not exist', async () => {
    const { service } = createService();

    await expect(service.getReport('999')).resolves.toBeNull();
    await expect(service.getReport('not-a-number')).resolves.toBeNull();
  });

  it('lists reports by type', async () => {
    const { repository, service } = createService();

    await expect(service.listReports({ type: 'focus_area' })).resolves.toEqual({
      reports: [
        {
          report_id: 2,
          template_id: 'focus_area',
          report_content: '{"summary":"focus"}',
          generated_at: '2026-06-25T09:00:00.000Z',
          render_status: 'success',
          fail_reason: '',
        },
      ],
    });
    expect(repository.listReportsByTemplateId).toHaveBeenCalledWith('focus_area');
  });
});
