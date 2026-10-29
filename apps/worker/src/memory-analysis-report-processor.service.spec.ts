import type { MemoryAnalysisReportMessage } from '@mem9/contracts';
import { deriveApiKeyFingerprint } from '@mem9/shared';

import { MemoryAnalysisReportProcessorService } from './memory-analysis-report-processor.service';

const config = { app: { pepper: 'test-pepper' } };
const fingerprint = deriveApiKeyFingerprint(config.app.pepper, 'space-key');
const message: MemoryAnalysisReportMessage = {
  messageType: 'memory_analysis_report',
  reportId: 7,
  apiKeyFingerprintHex: fingerprint.toString('hex'),
  rawApiKey: 'space-key',
  createdAfter: '2026-06-01T00:00:00.000Z',
  createdBefore: '2026-06-14T23:59:59.999Z',
  traceId: 'req_1',
};

function setup() {
  const report = {
    apiKeyFingerprint: fingerprint,
    startTime: new Date(message.createdAfter),
    endTime: new Date(message.createdBefore),
    renderStatus: 'queued',
  };
  const runner = { generateReport: jest.fn(async () => undefined) };
  const repository = { findMemoryAnalysisReport: jest.fn(async () => report as typeof report | null) };
  const processor = new MemoryAnalysisReportProcessorService(runner as never, repository as never, config as never);
  return { report, runner, repository, processor };
}

describe('MemoryAnalysisReportProcessorService', () => {
  it('runs an owned report with the existing rawApiKey queue format', async () => {
    const { processor, repository, runner } = setup();
    await processor.process(message);
    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledWith(fingerprint, 7);
    expect(runner.generateReport).toHaveBeenCalledWith(
      { apiKeyFingerprint: fingerprint, apiKeyFingerprintHex: fingerprint.toString('hex'), rawApiKey: 'space-key', requestId: 'req_1' },
      7,
      { createdAfter: message.createdAfter, createdBefore: message.createdBefore },
    );
  });

  it.each(['', 'ab', 'g'.repeat(64), `${fingerprint.toString('hex')}zz`])('rejects malformed fingerprints before looking up a report (%s)', async (apiKeyFingerprintHex) => {
    const { processor, repository, runner } = setup();
    await expect(processor.process({ ...message, apiKeyFingerprintHex })).rejects.toBeDefined();
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid report id %s', async (reportId) => {
    const { processor, repository, runner } = setup();
    await expect(processor.process({ ...message, reportId })).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each(['other-key', '', '  '])('rejects a credential that does not establish the claimed owner', async (rawApiKey) => {
    const { processor, repository, runner } = setup();
    await expect(processor.process({ ...message, rawApiKey })).rejects.toMatchObject({ code: 'INVALID_QUEUE_CREDENTIAL' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('rejects a substituted owner fingerprint', async () => {
    const { processor, repository, runner } = setup();
    await expect(processor.process({ ...message, apiKeyFingerprintHex: deriveApiKeyFingerprint(config.app.pepper, 'other-key').toString('hex') }))
      .rejects.toMatchObject({ code: 'INVALID_QUEUE_CREDENTIAL' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('rejects a report that is not owned by the credential holder', async () => {
    const { processor, repository, runner } = setup();
    repository.findMemoryAnalysisReport.mockResolvedValue(null);
    await expect(processor.process(message)).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledWith(fingerprint, message.reportId);
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('also checks the returned report owner', async () => {
    const { processor, report, runner } = setup();
    report.apiKeyFingerprint = Buffer.alloc(32, 9);
    await expect(processor.process(message)).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each([
    { createdAfter: 'not-a-date' },
    { createdBefore: message.createdAfter },
    { createdBefore: '2026-06-20T00:00:00.000Z' },
    { createdAfter: '2026-06-02T00:00:00.000Z' },
    { createdBefore: '2026-06-13T23:59:59.999Z' },
  ])('rejects invalid or substituted report dates %j', async (dates) => {
    const { processor, runner } = setup();
    await expect(processor.process({ ...message, ...dates })).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each(['success', 'fail'])('does not replay a terminal %s report', async (renderStatus) => {
    const { processor, report, runner } = setup();
    report.renderStatus = renderStatus;
    await processor.process(message);
    expect(runner.generateReport).not.toHaveBeenCalled();
  });
});
