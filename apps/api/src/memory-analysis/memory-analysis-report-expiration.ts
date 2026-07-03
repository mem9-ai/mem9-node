import type { MemoryReport } from '@prisma/client';

export const MEMORY_ANALYSIS_REPORT_TEMPLATE_ID = 'memory_analysis';
export const MEMORY_ANALYSIS_QUEUED_EXPIRE_MS = 10 * 60 * 1000;
export const MEMORY_ANALYSIS_RUNNING_EXPIRE_MS = 60 * 60 * 1000;
export const MEMORY_ANALYSIS_REPORT_EXPIRED_CODE = 'MEMORY_ANALYSIS_REPORT_EXPIRED';
export const MEMORY_ANALYSIS_REPORT_EXPIRED_REASON = 'Previous memory analysis report expired before completion.';

export function getMemoryAnalysisReportExpirationCutoffs(now: Date): {
  queuedBefore: Date;
  runningBefore: Date;
} {
  return {
    queuedBefore: new Date(now.getTime() - MEMORY_ANALYSIS_QUEUED_EXPIRE_MS),
    runningBefore: new Date(now.getTime() - MEMORY_ANALYSIS_RUNNING_EXPIRE_MS),
  };
}

export function isExpiredMemoryAnalysisReport(report: MemoryReport, now: Date): boolean {
  const { queuedBefore, runningBefore } = getMemoryAnalysisReportExpirationCutoffs(now);

  if (report.renderStatus === 'queued') {
    return report.generatedAt < queuedBefore;
  }

  if (report.renderStatus === 'running') {
    return (report.startedAt ?? report.generatedAt) < runningBefore;
  }

  return false;
}
