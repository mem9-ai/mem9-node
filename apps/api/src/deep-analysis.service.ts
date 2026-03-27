import type {
  CreateDeepAnalysisReportResponse,
  DeepAnalysisReportDetail,
  DeepAnalysisReportDocument,
  DeepAnalysisReportListItem,
  DeepAnalysisReportPreview,
  ListDeepAnalysisReportsResponse,
} from '@mem9/contracts';
import {
  AnalysisRepository,
  AppError,
  S3PayloadStorageService,
  SqsQueueService,
  createPrefixedId,
  gzipJson,
} from '@mem9/shared';
import { Injectable } from '@nestjs/common';
import { DeepAnalysisReportStatus, Prisma } from '@prisma/client';

import type { Mem9RequestContext } from './common/request-context';
import type { CreateDeepAnalysisReportDto } from './dto/create-deep-analysis-report.dto';
import type { ListDeepAnalysisReportsDto } from './dto/list-deep-analysis-reports.dto';
import { Mem9SourceService } from './mem9-source.service';

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

function isRunningStatus(status: DeepAnalysisReportStatus): boolean {
  return status === 'QUEUED' ||
    status === 'PREPARING' ||
    status === 'ANALYZING' ||
    status === 'SYNTHESIZING';
}

function buildExistingReportError(existing: {
  id: string;
  status: DeepAnalysisReportStatus;
}): AppError {
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

function toPreview(value: unknown): DeepAnalysisReportPreview | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as DeepAnalysisReportPreview;
}

function toListItem(report: {
  id: string;
  status: string;
  stage: string;
  progressPercent: number;
  lang: string;
  timezone: string;
  memoryCount: number;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  previewJson: unknown;
}): DeepAnalysisReportListItem {
  return {
    id: report.id,
    status: report.status as DeepAnalysisReportListItem['status'],
    stage: report.stage as DeepAnalysisReportListItem['stage'],
    progressPercent: report.progressPercent,
    lang: report.lang,
    timezone: report.timezone,
    memoryCount: report.memoryCount,
    requestedAt: report.requestedAt.toISOString(),
    startedAt: report.startedAt?.toISOString() ?? null,
    completedAt: report.completedAt?.toISOString() ?? null,
    errorCode: report.errorCode,
    errorMessage: report.errorMessage,
    preview: toPreview(report.previewJson),
  };
}

@Injectable()
export class DeepAnalysisService {
  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly source: Mem9SourceService,
    private readonly storage: S3PayloadStorageService,
    private readonly queue: SqsQueueService,
  ) {}

  public async createReport(
    context: Mem9RequestContext,
    dto: CreateDeepAnalysisReportDto,
  ): Promise<CreateDeepAnalysisReportResponse> {
    const timezone = normalizeTimezone(dto.timezone);
    const requestDayKey = buildRequestDayKey(timezone);
    const existing = await this.repository.findDeepAnalysisReportByDay(
      context.apiKeyFingerprint,
      requestDayKey,
    );

    if (existing !== null) {
      throw buildExistingReportError(existing);
    }

    const memoryCount = await this.source.countMemories(context.rawApiKey);

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

    const memories = await this.source.fetchAllMemories(context.rawApiKey);
    const sourceSnapshotObjectKey = `deep-analysis/reports/${createPrefixedId('snapshot')}/source.json.gz`;
    await this.storage.putCompressedJson(
      sourceSnapshotObjectKey,
      gzipJson({
        fetchedAt: new Date().toISOString(),
        memoryCount: memories.length,
        memories,
      }),
    );

    let report;
    try {
      report = await this.repository.createDeepAnalysisReport({
        fingerprint: context.apiKeyFingerprint,
        requestDayKey,
        lang: dto.lang.trim() || 'zh-CN',
        timezone,
        memoryCount: memories.length,
        sourceSnapshotObjectKey,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const concurrent = await this.repository.findDeepAnalysisReportByDay(
          context.apiKeyFingerprint,
          requestDayKey,
        );
        if (concurrent !== null) {
          throw buildExistingReportError(concurrent);
        }
      }
      throw error;
    }

    await this.queue.enqueueLlmMessage({
      messageType: 'deep_report',
      reportId: report.id,
      traceId: context.requestId,
    });

    return {
      reportId: report.id,
      status: report.status,
      stage: report.stage,
      progressPercent: report.progressPercent,
      requestedAt: report.requestedAt.toISOString(),
      memoryCount: report.memoryCount,
    };
  }

  public async listReports(
    context: Mem9RequestContext,
    query: ListDeepAnalysisReportsDto,
  ): Promise<ListDeepAnalysisReportsResponse> {
    const { reports, total } = await this.repository.listOwnedDeepAnalysisReports(
      context.apiKeyFingerprint,
      query.limit,
      query.offset,
    );

    return {
      reports: reports.map((report) => toListItem(report)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  public async getReport(
    context: Mem9RequestContext,
    reportId: string,
  ): Promise<DeepAnalysisReportDetail> {
    const report = await this.repository.getOwnedDeepAnalysisReport(
      reportId,
      context.apiKeyFingerprint,
    );
    let document: DeepAnalysisReportDocument | null = null;

    if (report.reportObjectKey) {
      const payload = await this.storage.getObjectBuffer(report.reportObjectKey);
      document = JSON.parse(payload.toString('utf8')) as DeepAnalysisReportDocument;
    }

    return {
      ...toListItem(report),
      report: document,
    };
  }
}
