import { MemoryAnalysisReportCleanupService } from './memory-analysis-report-cleanup.service';
import {
  MEMORY_ANALYSIS_REPORT_EXPIRED_CODE,
  MEMORY_ANALYSIS_REPORT_EXPIRED_REASON,
  MEMORY_ANALYSIS_REPORT_TEMPLATE_ID,
} from './memory-analysis-report-expiration';

describe('memory analysis report cleanup service', () => {
  it('expires stale queued and running memory analysis reports', async () => {
    const repository = {
      expireStaleMemoryAnalysisReports: jest.fn(async () => 2),
    };
    const service = new MemoryAnalysisReportCleanupService(repository as never);
    const now = new Date('2026-06-30T08:00:00.000Z');

    await expect(service.runOnce(now)).resolves.toBe(2);

    expect(repository.expireStaleMemoryAnalysisReports).toHaveBeenCalledWith({
      templateId: MEMORY_ANALYSIS_REPORT_TEMPLATE_ID,
      queuedBefore: new Date('2026-06-30T07:50:00.000Z'),
      runningBefore: new Date('2026-06-30T07:00:00.000Z'),
      completedAt: now,
      failCode: MEMORY_ANALYSIS_REPORT_EXPIRED_CODE,
      failReason: MEMORY_ANALYSIS_REPORT_EXPIRED_REASON,
    });
  });

  it('skips overlapping cleanup runs', async () => {
    let resolveCleanup: (count: number) => void = () => undefined;
    const repository = {
      expireStaleMemoryAnalysisReports: jest.fn(() => new Promise<number>((resolve) => {
        resolveCleanup = resolve;
      })),
    };
    const service = new MemoryAnalysisReportCleanupService(repository as never);

    const firstRun = service.runOnce(new Date('2026-06-30T08:00:00.000Z'));
    await expect(service.runOnce(new Date('2026-06-30T08:00:01.000Z'))).resolves.toBe(0);

    resolveCleanup(1);
    await expect(firstRun).resolves.toBe(1);
    expect(repository.expireStaleMemoryAnalysisReports).toHaveBeenCalledTimes(1);
  });
});
