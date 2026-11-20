import { randomBytes } from 'node:crypto';

import { parseQueueCredentialKeyring } from '@mem9/config';
import type { MemoryAnalysisReportMessage } from '@mem9/contracts';
import { deriveApiKeyFingerprint, sealQueueCredential } from '@mem9/shared';

import { MemoryAnalysisReportProcessorService } from './memory-analysis-report-processor.service';

const queueCredentialKeyring = parseQueueCredentialKeyring(
  JSON.stringify({ encryption_kid: 'k1', encryption_keys: { k1: randomBytes(32).toString('base64') } }),
);
const config = { app: { pepper: 'test-pepper' }, queueCredentialKeyring };
const fingerprint = deriveApiKeyFingerprint(config.app.pepper, 'space-key');
const baseMessage = {
  messageType: 'memory_analysis_report' as const,
  reportId: 7,
  apiKeyFingerprintHex: fingerprint.toString('hex'),
  createdAfter: '2026-06-01T00:00:00.000Z',
  createdBefore: '2026-06-14T23:59:59.999Z',
  traceId: 'req_1',
};

function sealFor(apiKey: string, overrides?: Partial<typeof baseMessage>): string {
  const scope = { ...baseMessage, ...overrides };
  return sealQueueCredential(queueCredentialKeyring, apiKey, {
    reportId: scope.reportId,
    apiKeyFingerprintHex: scope.apiKeyFingerprintHex,
    createdAfter: scope.createdAfter,
    createdBefore: scope.createdBefore,
  });
}

const message: MemoryAnalysisReportMessage = {
  ...baseMessage,
  encryptedApiKey: sealFor('space-key'),
};

function setup() {
  const report = {
    apiKeyFingerprint: fingerprint,
    startTime: new Date(message.createdAfter),
    endTime: new Date(message.createdBefore),
    renderStatus: 'queued',
  };
  const runner = { generateReport: jest.fn(async () => undefined) };
  const repository = {
    findMemoryAnalysisReport: jest.fn(async () => report as typeof report | null),
    updateMemoryAnalysisReport: jest.fn(),
  };
  const processor = new MemoryAnalysisReportProcessorService(runner as never, repository as never, config as never);
  return { report, runner, repository, processor };
}

describe('MemoryAnalysisReportProcessorService', () => {
  it('decrypts the queued credential and runs an owned report', async () => {
    const { processor, repository, runner } = setup();
    await processor.process(message);
    expect(repository.findMemoryAnalysisReport).toHaveBeenCalledWith(fingerprint, 7);
    expect(runner.generateReport).toHaveBeenCalledWith(
      { apiKeyFingerprint: fingerprint, apiKeyFingerprintHex: fingerprint.toString('hex'), rawApiKey: 'space-key', requestId: 'req_1' },
      7,
      { createdAfter: message.createdAfter, createdBefore: message.createdBefore },
    );
  });

  describe('credential rejection drops the message (resolves, so the consumer deletes it)', () => {
    async function expectDropped(input: unknown) {
      const { processor, repository, runner } = setup();
      await expect(processor.process(input as MemoryAnalysisReportMessage)).resolves.toBeUndefined();
      expect(runner.generateReport).not.toHaveBeenCalled();
      expect(repository.updateMemoryAnalysisReport).not.toHaveBeenCalled();
      return { repository };
    }

    it('drops a legacy plaintext message and never reads rawApiKey', async () => {
      const legacy: Record<string, unknown> = { ...message, rawApiKey: 'space-key' };
      delete legacy.encryptedApiKey;
      const { repository } = await expectDropped(legacy);
      expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    });

    it('drops a message carrying both rawApiKey and a valid envelope', async () => {
      await expectDropped({ ...message, rawApiKey: 'space-key' });
    });

    it.each([
      ['missing envelope', undefined],
      ['empty envelope', ''],
      ['plaintext key in the envelope field', 'space-key'],
      ['garbage envelope', '{"v":1}'],
    ])('drops a message with %s', async (_label, encryptedApiKey) => {
      const { repository } = await expectDropped({ ...message, encryptedApiKey });
      expect(repository.findMemoryAnalysisReport).not.toHaveBeenCalled();
    });

    it('drops an envelope sealed for another report', async () => {
      await expectDropped({ ...message, encryptedApiKey: sealFor('space-key', { reportId: 8 }) });
    });

    it('drops an envelope moved to a different date range', async () => {
      await expectDropped({ ...message, createdAfter: '2026-06-02T00:00:00.000Z' });
    });

    it('drops an envelope whose key does not establish the claimed owner', async () => {
      await expectDropped({ ...message, encryptedApiKey: sealFor('other-key') });
    });

    it('drops a substituted owner fingerprint even with a matching envelope scope', async () => {
      const otherFingerprintHex = deriveApiKeyFingerprint(config.app.pepper, 'other-key').toString('hex');
      await expectDropped({
        ...message,
        apiKeyFingerprintHex: otherFingerprintHex,
        encryptedApiKey: sealFor('space-key', { apiKeyFingerprintHex: otherFingerprintHex }),
      });
    });

    it('drops an expired envelope', async () => {
      const expired = sealQueueCredential(queueCredentialKeyring, 'space-key', {
        reportId: message.reportId,
        apiKeyFingerprintHex: message.apiKeyFingerprintHex,
        createdAfter: message.createdAfter,
        createdBefore: message.createdBefore,
      }, new Date(Date.now() - 11 * 60 * 1000));
      await expectDropped({ ...message, encryptedApiKey: expired });
    });

    it('logs the rejection without key material', async () => {
      const { processor } = setup();
      const loggerTarget = processor as unknown as { logger: { warn: jest.Mock; error: jest.Mock; log: jest.Mock } };
      const calls: unknown[][] = [];
      for (const level of ['warn', 'error', 'log'] as const) {
        jest.spyOn(loggerTarget.logger, level).mockImplementation((...args: unknown[]) => {
          calls.push(args);
        });
      }

      await processor.process({ ...message, encryptedApiKey: sealFor('space-key', { reportId: 8 }), rawApiKey: 'space-key' } as never);

      const logged = JSON.stringify(calls);
      expect(logged).toContain('memory_analysis_report_credential_rejected');
      expect(logged).not.toContain('space-key');
    });
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
    { createdBefore: '2026-06-20T00:00:00.000Z' },
    { createdBefore: '2026-06-13T23:59:59.999Z' },
  ])('rejects a report whose stored range differs from a correctly sealed message %j', async (dates) => {
    const { processor, runner } = setup();
    await expect(processor.process({ ...message, ...dates, encryptedApiKey: sealFor('space-key', dates) }))
      .rejects.toMatchObject({ code: 'INVALID_REPORT_MESSAGE' });
    expect(runner.generateReport).not.toHaveBeenCalled();
  });

  it.each(['success', 'fail'])('does not replay a terminal %s report', async (renderStatus) => {
    const { processor, report, runner } = setup();
    report.renderStatus = renderStatus;
    await processor.process(message);
    expect(runner.generateReport).not.toHaveBeenCalled();
  });
});
