import type { MemoryAnalysisReportMessage } from '@mem9/contracts';
import { Injectable, Logger } from '@nestjs/common';

import { MemoryAnalysisReportRunnerService } from './memory-analysis-report-runner.service';

@Injectable()
export class MemoryAnalysisReportProcessorService {
  private readonly logger = new Logger(MemoryAnalysisReportProcessorService.name);

  public constructor(private readonly runner: MemoryAnalysisReportRunnerService) {}

  public async process(message: MemoryAnalysisReportMessage): Promise<void> {
    const apiKeyFingerprint = Buffer.from(message.apiKeyFingerprintHex, 'hex');
    if (apiKeyFingerprint.length === 0 || !Number.isInteger(message.reportId) || message.reportId <= 0) {
      this.logger.warn(JSON.stringify({
        event: 'memory_analysis_report_message_invalid',
        reportId: message.reportId,
        traceId: message.traceId,
      }));
      return;
    }

    await this.runner.generateReport(
      {
        apiKeyFingerprint,
        apiKeyFingerprintHex: message.apiKeyFingerprintHex,
        rawApiKey: message.rawApiKey,
        requestId: message.traceId,
      },
      message.reportId,
      {
        createdAfter: message.createdAfter,
        createdBefore: message.createdBefore,
      },
    );
  }
}
