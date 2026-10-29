import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { MemoryAnalysisReportMessage } from '@mem9/contracts';
import {
  AnalysisRepository,
  AppError,
  deriveApiKeyFingerprint,
  parseApiKeyFingerprint,
  safeFingerprintEquals,
} from '@mem9/shared';
import { Inject, Injectable } from '@nestjs/common';

import { MemoryAnalysisReportRunnerService } from './memory-analysis-report-runner.service';

@Injectable()
export class MemoryAnalysisReportProcessorService {
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
    if (typeof message.rawApiKey !== 'string' || !message.rawApiKey.trim()
      || !safeFingerprintEquals(deriveApiKeyFingerprint(this.config.app.pepper, message.rawApiKey), fingerprint)) {
      throw new AppError('Credential owner mismatch', { statusCode: 403, code: 'INVALID_QUEUE_CREDENTIAL' });
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
        rawApiKey: message.rawApiKey,
        requestId: message.traceId,
      },
      message.reportId,
      { createdAfter: message.createdAfter, createdBefore: message.createdBefore },
    );
  }
}
