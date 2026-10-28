import { AppError } from '@mem9/shared';
import type { DeepAnalysisReportStatus } from '@prisma/client';

interface ExistingReport {
  id: string;
  status: DeepAnalysisReportStatus;
  deletedAt?: Date | null;
}

interface ResolveCreateReportPolicyInput {
  env: 'development' | 'test' | 'production';
  existingReports: ExistingReport[];
  memoryCount: number;
  bypassFingerprints: string[];
  apiKeyFingerprintHex: string;
}

export interface DeepAnalysisCreatePolicyResult {
  bypassDailyLimit: boolean;
  isProduction: boolean;
}

const MAX_DAILY_REPORTS = 3;

function normalizeTimezone(input: string): string {
  const timezone = input.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new AppError('Invalid timezone', {
      statusCode: 422,
      code: 'INVALID_TIMEZONE',
    });
  }
}

function isRunningStatus(status: DeepAnalysisReportStatus): boolean {
  return status === 'QUEUED' ||
    status === 'PREPARING' ||
    status === 'ANALYZING' ||
    status === 'SYNTHESIZING';
}

function isTerminalStatus(status: DeepAnalysisReportStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

function buildExistingReportError(existing: ExistingReport): AppError {
  const running = !existing.deletedAt && isRunningStatus(existing.status);
  return new AppError(
    running
      ? 'A deep analysis report is already running'
      : `Deep analysis can be executed at most ${MAX_DAILY_REPORTS} times per day`,
    {
      statusCode: 409,
      code: running
        ? 'DEEP_ANALYSIS_ALREADY_RUNNING'
        : 'DEEP_ANALYSIS_DAILY_LIMIT',
      details: {
        reportId: existing.id,
        ...(running ? {} : { maximumPerDay: MAX_DAILY_REPORTS }),
      },
    },
  );
}

function resolveCreateReport({
  env,
  existingReports,
  memoryCount,
  bypassFingerprints,
  apiKeyFingerprintHex,
}: ResolveCreateReportPolicyInput): DeepAnalysisCreatePolicyResult {
  const isProduction = env === 'production';
  const bypassDailyLimit = isProduction &&
    bypassFingerprints.includes(apiKeyFingerprintHex.toLowerCase());

  if (isProduction) {
    const runningReport = existingReports.find((report) =>
      !report.deletedAt && isRunningStatus(report.status));

    if (runningReport) {
      throw buildExistingReportError(runningReport);
    }

    if (!bypassDailyLimit && existingReports.length >= MAX_DAILY_REPORTS) {
      throw buildExistingReportError(existingReports[0]!);
    }

    if (memoryCount > 20000) {
      throw new AppError('Deep analysis supports at most 20000 memories', {
        statusCode: 422,
        code: 'DEEP_ANALYSIS_TOO_MANY_MEMORIES',
        details: {
          memoryCount,
          maximum: 20000,
        },
      });
    }
  }

  return {
    bypassDailyLimit,
    isProduction,
  };
}

export const DeepAnalysisPolicy = {
  normalizeTimezone,
  isRunningStatus,
  isTerminalStatus,
  buildExistingReportError,
  resolveCreateReport,
};
