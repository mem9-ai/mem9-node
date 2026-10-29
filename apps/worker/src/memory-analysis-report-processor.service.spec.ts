import type { MemoryAnalysisReportMessage } from '@mem9/contracts';
import { deriveApiKeyFingerprint, encryptQueueCredential } from '@mem9/shared';

import { MemoryAnalysisReportProcessorService } from './memory-analysis-report-processor.service';

const now = new Date('2026-10-29T02:00:00.000Z');
const config = {
  app: { pepper: 'test-pepper' },
  analysis: { queueEncryptionKeys: `test:${Buffer.alloc(32, 1).toString('base64')}` },
};
const fingerprint = deriveApiKeyFingerprint(config.app.pepper, 'space-key');
const scope = {
  reportId: 7,
  apiKeyFingerprintHex: fingerprint.toString('hex'),
  createdAfter: '2026-06-01T00:00:00.000Z',
  createdBefore: '2026-06-14T23:59:59.999Z',
};

function makeMessage(overrides: Partial<typeof scope> = {}, rawApiKey = 'space-key'): MemoryAnalysisReportMessage {
  const binding = { ...scope, ...overrides };
  return {
    ...binding,
    messageType: 'memory_analysis_report',
    encryptedApiKey: encryptQueueCredential(config.analysis.queueEncryptionKeys, rawApiKey, binding, now),
    traceId: 'req_1',
  };
}

function setup() {
  const report = {
    apiKeyFingerprint: fingerprint,
    startTime: new Date(scope.createdAfter),
    endTime: new Date(scope.createdBefore),
    renderStatus: 'queued',
  };
  const runner = { generateReport: jest.fn(async () => undefined) };
  const repository = { findMemoryAnalysisReport: jest.fn(async () => report as typeof report | null) };
  const processor = new MemoryAnalysisReportProcessorService(runner as never, repository as never, config as never);
  return { report, runner, repository, processor, message: makeMessage() };
}

describe('MemoryAnalysisReportProcessorService', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('decrypts an owned report credential only into the in-process runner context', async () => {
    const { processor, repository, runner, message } = setup();
    await processor.process(message);
    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledWith(fingerprint, 7);
    expect(runner.generateReport).toHaveBeenCalledWith(
      { apiKeyFingerprint: fingerprint, apiKeyFingerprintHex: fingerprint.toString('hex'), rawApiKey: 'space-key', requestId: 'req_1' },
      7,
      { createdAfter: scope.createdAfter, createdBefore: scope.createdBefore },
    );
    expect(message).not.toHaveProperty('rawApiKey');
    expect(JSON.stringify(message)).not.toContain('space-key');
  });

  it.each([undefined, null, {}, { messageType: 'other' }])('rejects invalid message structure before side effects', async (message) => {
    const { processor, repository, runner } = setup();
    await expect(processor.process(message as never)).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each(['', 'ab', 'g'.repeat(64), `${fingerprint.toString('hex')}zz`])('rejects malformed fingerprints before looking up a report (%s)', async (apiKeyFingerprintHex) => {
    const { processor, repository, runner, message } = setup();
    await expect(processor.process({ ...message, apiKeyFingerprintHex })).rejects.toBeDefined();
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid report id %s', async (reportId) => {
    const { processor, repository, runner, message } = setup();
    await expect(processor.process({ ...message, reportId })).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects a legacy plaintext field even with an encrypted credential present: %s', async (includeEncrypted) => {
    const { processor, repository, runner, message } = setup();
    const legacy = { ...message, rawApiKey: 'space-key', encryptedApiKey: includeEncrypted ? message.encryptedApiKey : undefined };
    await expect(processor.process(legacy as never)).rejects.toMatchObject({ code: 'INVALID_QUEUE_CREDENTIAL' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('rejects even an undefined legacy field to keep the accepted contract unambiguous', async () => {
    const { processor, repository, runner, message } = setup();
    await expect(processor.process({ ...message, rawApiKey: undefined } as never))
      .rejects.toMatchObject({ code: 'INVALID_QUEUE_CREDENTIAL' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('rejects an encrypted credential that does not establish the claimed owner', async () => {
    const { processor, repository, runner } = setup();
    await expect(processor.process(makeMessage({}, 'other-key'))).rejects.toMatchObject({ code: 'INVALID_QUEUE_CREDENTIAL' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each([
    { apiKeyFingerprintHex: deriveApiKeyFingerprint(config.app.pepper, 'other-key').toString('hex') },
    { reportId: 8 },
    { createdAfter: '2026-06-02T00:00:00.000Z' },
    { createdBefore: '2026-06-13T23:59:59.999Z' },
  ])('rejects substitution of authenticated message bindings before repository access', async (binding) => {
    const { processor, repository, runner, message } = setup();
    await expect(processor.process({ ...message, ...binding })).rejects.toMatchObject({ code: 'INVALID_QUEUE_CREDENTIAL' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('rejects ciphertext tampering without exposing the envelope', async () => {
    const { processor, repository, runner, message } = setup();
    const last = message.encryptedApiKey.slice(-1);
    const encryptedApiKey = message.encryptedApiKey.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    await expect(processor.process({ ...message, encryptedApiKey })).rejects.toMatchObject({ code: 'INVALID_QUEUE_CREDENTIAL' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('rejects expired credentials before any report lookup or execution', async () => {
    const { processor, repository, runner, message } = setup();
    jest.setSystemTime(new Date(now.getTime() + 11 * 60 * 1000));
    await expect(processor.process(message)).rejects.toMatchObject({ code: 'INVALID_QUEUE_CREDENTIAL' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('rejects a report that is not owned by the credential holder', async () => {
    const { processor, repository, runner, message } = setup();
    repository.findMemoryAnalysisReport.mockResolvedValue(null);
    await expect(processor.process(message)).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledWith(fingerprint, message.reportId);
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('also checks the returned report owner', async () => {
    const { processor, report, runner, message } = setup();
    report.apiKeyFingerprint = Buffer.alloc(32, 9);
    await expect(processor.process(message)).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each([
    { createdAfter: 'not-a-date' },
    { createdBefore: scope.createdAfter },
    { createdBefore: '2026-06-20T00:00:00.000Z' },
  ])('rejects an invalid report date range before repository access', async (dates) => {
    const { processor, repository, runner, message } = setup();
    await expect(processor.process({ ...message, ...dates })).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each([
    { createdAfter: '2026-06-02T00:00:00.000Z' },
    { createdBefore: '2026-06-13T23:59:59.999Z' },
  ])('rejects authenticated dates that do not match the stored report', async (dates) => {
    const { processor, runner } = setup();
    await expect(processor.process(makeMessage(dates))).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each(['success', 'fail'])('does not replay a terminal %s report', async (renderStatus) => {
    const { processor, report, runner, message } = setup();
    report.renderStatus = renderStatus;
    await processor.process(message);
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it('rejects an unknown stored report state without running it', async () => {
    const { processor, report, runner, message } = setup();
    report.renderStatus = 'unexpected';
    await expect(processor.process(message)).rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(runner.generateReport).not.toHaveBeenCalled();
  });
});
