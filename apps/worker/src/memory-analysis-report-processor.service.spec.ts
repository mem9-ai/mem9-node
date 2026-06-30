import { MemoryAnalysisReportProcessorService } from './memory-analysis-report-processor.service';

describe('MemoryAnalysisReportProcessorService', () => {
  it('runs memory analysis report generation from queue messages', async () => {
    const memoryAnalysis = {
      generateReport: jest.fn(async () => undefined),
    };
    const processor = new MemoryAnalysisReportProcessorService(memoryAnalysis as never);

    await processor.process({
      messageType: 'memory_analysis_report',
      reportId: 7,
      apiKeyFingerprintHex: Buffer.alloc(32, 3).toString('hex'),
      rawApiKey: 'space-key',
      createdAfter: '2026-06-01T00:00:00.000Z',
      createdBefore: '2026-06-14T23:59:59.999Z',
      traceId: 'req_1',
    });

    expect(memoryAnalysis.generateReport).toHaveBeenCalledWith(
      {
        apiKeyFingerprint: Buffer.alloc(32, 3),
        apiKeyFingerprintHex: Buffer.alloc(32, 3).toString('hex'),
        rawApiKey: 'space-key',
        requestId: 'req_1',
      },
      7,
      {
        createdAfter: '2026-06-01T00:00:00.000Z',
        createdBefore: '2026-06-14T23:59:59.999Z',
      },
    );
  });
});
