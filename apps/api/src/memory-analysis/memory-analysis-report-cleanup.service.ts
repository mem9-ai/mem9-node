import { AnalysisRepository } from '@mem9/shared';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import {
  getMemoryAnalysisReportExpirationCutoffs,
  MEMORY_ANALYSIS_REPORT_EXPIRED_CODE,
  MEMORY_ANALYSIS_REPORT_EXPIRED_REASON,
  MEMORY_ANALYSIS_REPORT_TEMPLATE_ID,
} from './memory-analysis-report-expiration';

const MEMORY_ANALYSIS_REPORT_CLEANUP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class MemoryAnalysisReportCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MemoryAnalysisReportCleanupService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  public constructor(private readonly repository: AnalysisRepository) {}

  public onApplicationBootstrap(): void {
    this.runOnce().catch((error) => this.logCleanupFailure(error));
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => this.logCleanupFailure(error));
    }, MEMORY_ANALYSIS_REPORT_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  public onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runOnce(now = new Date()): Promise<number> {
    if (this.isRunning) {
      return 0;
    }

    this.isRunning = true;
    try {
      const { queuedBefore, runningBefore } = getMemoryAnalysisReportExpirationCutoffs(now);
      const count = await this.repository.expireStaleMemoryAnalysisReports({
        templateId: MEMORY_ANALYSIS_REPORT_TEMPLATE_ID,
        queuedBefore,
        runningBefore,
        completedAt: now,
        failCode: MEMORY_ANALYSIS_REPORT_EXPIRED_CODE,
        failReason: MEMORY_ANALYSIS_REPORT_EXPIRED_REASON,
      });

      if (count > 0) {
        this.logger.warn(JSON.stringify({
          event: 'memory_analysis_report_cleanup_expired',
          count,
          queuedBefore: queuedBefore.toISOString(),
          runningBefore: runningBefore.toISOString(),
        }));
      }

      return count;
    } finally {
      this.isRunning = false;
    }
  }

  private logCleanupFailure(error: unknown): void {
    this.logger.error(JSON.stringify({
      event: 'memory_analysis_report_cleanup_failed',
    }), error instanceof Error ? error.stack : undefined);
  }
}
