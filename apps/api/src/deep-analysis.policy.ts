import { AppError } from '@mem9/shared';
import type { DeepAnalysisReportStatus } from '@prisma/client';

interface ExistingReport {
  id: string;
  status: DeepAnalysisReportStatus;
}

interface ResolveCreateReportPolicyInput {
  env: 'development' | 'test' | 'production';
  timezone: string;
  existingReports: ExistingReport[];
  memoryCount: number;
  bypassFingerprints: string[];
  apiKeyFingerprintHex: string;
  now?: Date;
}

export interface DeepAnalysisCreatePolicyResult {
  baseRequestDayKey: string;
  requestDayKey: string;
  bypassDailyLimit: boolean;
  isProduction: boolean;
}

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

function buildRequestDayKey(timezone: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '00';
  const day = parts.find((part) => part.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}@${timezone}`;
}

function buildScopedRequestDayKey(baseRequestDayKey: string, scope: 'dev' | 'rerun'): string {
  const suffix = `${scope}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${baseRequestDayKey}#${suffix}`;
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
  return new AppError(
    isRunningStatus(existing.status)
      ? 'A deep analysis report is already running for today'
      : 'Deep analysis can only be executed once per day',
    {
      statusCode: 409,
      code: isRunningStatus(existing.status)
        ? 'DEEP_ANALYSIS_ALREADY_RUNNING'
        : 'DEEP_ANALYSIS_DAILY_LIMIT',
      details: {
        reportId: existing.id,
      },
    },
  );
}

function resolveCreateReport({
  env,
  timezone,
  existingReports,
  memoryCount,
  bypassFingerprints,
  apiKeyFingerprintHex,
  now,
}: ResolveCreateReportPolicyInput): DeepAnalysisCreatePolicyResult {
  const baseRequestDayKey = buildRequestDayKey(timezone, now);
  const isProduction = env === 'production';
  const bypassDailyLimit = isProduction &&
    bypassFingerprints.includes(apiKeyFingerprintHex.toLowerCase());

  if (isProduction) {
    const runningReport = existingReports.find((report) => isRunningStatus(report.status));

    if (runningReport) {
      throw buildExistingReportError(runningReport);
    }

    if (!bypassDailyLimit && existingReports.length > 0) {
      throw buildExistingReportError(existingReports[0]!);
    }

    if (memoryCount < 1000) {
      throw new AppError('Deep analysis requires at least 1000 memories', {
        statusCode: 422,
        code: 'DEEP_ANALYSIS_TOO_FEW_MEMORIES',
        details: {
          memoryCount,
          minimum: 1000,
        },
      });
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
    baseRequestDayKey,
    requestDayKey: isProduction
      ? (bypassDailyLimit
        ? buildScopedRequestDayKey(baseRequestDayKey, 'rerun')
        : baseRequestDayKey)
      : buildScopedRequestDayKey(baseRequestDayKey, 'dev'),
    bypassDailyLimit,
    isProduction,
  };
}

export const DeepAnalysisPolicy = {
  normalizeTimezone,
  buildRequestDayKey,
  buildScopedRequestDayKey,
  isRunningStatus,
  isTerminalStatus,
  buildExistingReportError,
  resolveCreateReport,
};
