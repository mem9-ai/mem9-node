import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { MemoryAnalysisReportMessage } from '@mem9/contracts';
import {
  AnalysisRepository,
  AppError,
  deriveApiKeyFingerprint,
  parseApiKeyFingerprint,
  safeFingerprintEquals,
  openQueueCredential,
} from '@mem9/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { MemoryAnalysisReportRunnerService } from './memory-analysis-report-runner.service';

@Injectable()
export class MemoryAnalysisReportProcessorService {
  private readonly logger = new Logger(MemoryAnalysisReportProcessorService.name);

  public constructor(
    private readonly runner: MemoryAnalysisReportRunnerService,
    private readonly repository: AnalysisRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async process(message: MemoryAnalysisReportMessage): Promise<void> {
    if (message?.messageType !== 'memory_analysis_report'
      || !Number.isSafeInteger(message.reportId) || message.reportId <= 0
      || typeof message.createdAfter !== 'string' || typeof message.createdBefore !== 'string') {
      throw new AppError('Invalid report message', { statusCode: 403, code: 'INVALID_REPORT_MESSAGE' });
    }
    const fingerprint = parseApiKeyFingerprint(message.apiKeyFingerprintHex);
    let apiKey: string;
    if (Object.hasOwn(message, 'rawApiKey')) {
      return this.rejectCredential(message.reportId, 'legacy_plaintext');
    }
    if (typeof message.encryptedApiKey !== 'string' || message.encryptedApiKey.length === 0
      || this.config.queueCredentialKeyring === undefined) {
      return this.rejectCredential(message.reportId, 'invalid_envelope');
    }
    try {
      apiKey = openQueueCredential(
        this.config.queueCredentialKeyring,
        message.encryptedApiKey,
        {
          reportId: message.reportId,
          apiKeyFingerprintHex: message.apiKeyFingerprintHex,
          createdAfter: message.createdAfter,
          createdBefore: message.createdBefore,
        },
      );
    } catch {
      return this.rejectCredential(message.reportId, 'invalid_envelope');
    }
    if (!safeFingerprintEquals(deriveApiKeyFingerprint(this.config.app.pepper, apiKey), fingerprint)) {
      return this.rejectCredential(message.reportId, 'owner_mismatch');
    }
    const start = Date.parse(message.createdAfter);
    const end = Date.parse(message.createdBefore);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 14 * 24 * 60 * 60 * 1000) {
      throw new AppError('Invalid report date range', { statusCode: 403, code: 'INVALID_REPORT_MESSAGE' });
    }
    const report = await this.repository.findMemoryAnalysisReport(fingerprint, message.reportId);
    if (!report || !safeFingerprintEquals(Buffer.from(report.apiKeyFingerprint), fingerprint)
      || report.startTime?.getTime() !== start || report.endTime?.getTime() !== end) {
      throw new AppError('Report message ownership or range mismatch', { statusCode: 403, code: 'INVALID_REPORT_MESSAGE' });
    }
    if (report.renderStatus === 'success' || report.renderStatus === 'fail') return;
    if (report.renderStatus !== 'queued' && report.renderStatus !== 'running') {
      throw new AppError('Invalid report state', { statusCode: 403, code: 'INVALID_REPORT_MESSAGE' });
    }

    await this.runner.generateReport(
      {
        apiKeyFingerprint: fingerprint,
        apiKeyFingerprintHex: fingerprint.toString('hex'),
        rawApiKey: apiKey,
        requestId: message.traceId,
      },
      message.reportId,
      { createdAfter: message.createdAfter, createdBefore: message.createdBefore },
    );
  }

  private rejectCredential(reportId: number, reason: string): void {
    this.logger.warn(JSON.stringify({
      event: 'memory_analysis_report_credential_rejected',
      reportId,
      reason,
    }));
  }
}
