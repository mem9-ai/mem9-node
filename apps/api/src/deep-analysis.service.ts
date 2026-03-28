import type {
  CreateDeepAnalysisReportResponse,
  DeleteDeepAnalysisDuplicatesResponse,
  DeepAnalysisDuplicateExportRow,
  DeepAnalysisMemorySnapshot,
  DeepAnalysisReportDetail,
  DeepAnalysisReportDocument,
  DeepAnalysisReportListItem,
  DeepAnalysisReportPreview,
  ListDeepAnalysisReportsResponse,
} from '@mem9/contracts';
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import {
  AnalysisRepository,
  AppError,
  S3PayloadStorageService,
  SqsQueueService,
  createPrefixedId,
  gunzipJson,
  gzipJson,
} from '@mem9/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeepAnalysisReportStage, DeepAnalysisReportStatus, Prisma } from '@prisma/client';

import type { Mem9RequestContext } from './common/request-context';
import type { CreateDeepAnalysisReportDto } from './dto/create-deep-analysis-report.dto';
import type { ListDeepAnalysisReportsDto } from './dto/list-deep-analysis-reports.dto';
import { Mem9SourceService } from './mem9-source.service';

interface SourceSnapshotPayload {
  fetchedAt: string;
  memoryCount: number;
  memories: DeepAnalysisMemorySnapshot[];
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

function sentencePreview(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function escapeCsvCell(value: string | number): string {
  const normalized = String(value)
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, '""');
  return `"${normalized}"`;
}

function buildDuplicateCsv(rows: DeepAnalysisDuplicateExportRow[]): string {
  const header = [
    'duplicateMemoryId',
    'clusterIndex',
    'canonicalPreview',
    'duplicatePreview',
    'reason',
  ];

  const body = rows.map((row) =>
    [
      row.duplicateMemoryId,
      row.clusterIndex,
      row.canonicalPreview,
      row.duplicatePreview,
      row.reason,
    ].map((value) => escapeCsvCell(value)).join(','));

  return `\uFEFF${[header.map((value) => escapeCsvCell(value)).join(','), ...body].join('\n')}\n`;
}

function buildDuplicateCsvFilename(reportId: string): string {
  return `deep-analysis-${reportId}-duplicate-cleanup.csv`;
}

@Injectable()
export class DeepAnalysisService {
  private readonly logger = new Logger(DeepAnalysisService.name);

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly source: Mem9SourceService,
    private readonly storage: S3PayloadStorageService,
    private readonly queue: SqsQueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async createReport(
    context: Mem9RequestContext,
    dto: CreateDeepAnalysisReportDto,
  ): Promise<CreateDeepAnalysisReportResponse> {
    const timezone = normalizeTimezone(dto.timezone);
    const baseRequestDayKey = buildRequestDayKey(timezone);
    const isProduction = this.config.app.env === 'production';
    const bypassDailyLimit = isProduction &&
      this.config.analysis.deepAnalysisDailyLimitBypassFingerprints.includes(
        context.apiKeyFingerprintHex.toLowerCase(),
      );

    if (isProduction) {
      const existingReports = await this.repository.findDeepAnalysisReportsByDayPrefix(
        context.apiKeyFingerprint,
        baseRequestDayKey,
      );
      const runningReport = existingReports.find((report) => isRunningStatus(report.status));

      if (runningReport) {
        throw buildExistingReportError(runningReport);
      }

      if (!bypassDailyLimit && existingReports.length > 0) {
        throw buildExistingReportError(existingReports[0]!);
      }
    }

    const memoryCount = await this.source.countMemories(context.rawApiKey);

    if (isProduction) {
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

    const requestDayKey = isProduction
      ? (bypassDailyLimit
        ? buildScopedRequestDayKey(baseRequestDayKey, 'rerun')
        : baseRequestDayKey)
      : buildScopedRequestDayKey(baseRequestDayKey, 'dev');

    const sourceSnapshotObjectKey = `deep-analysis/reports/${createPrefixedId('snapshot')}/source.json.gz`;

    let report;
    try {
      report = await this.repository.createDeepAnalysisReport({
        fingerprint: context.apiKeyFingerprint,
        requestDayKey,
        lang: dto.lang.trim() || 'zh-CN',
        timezone,
        memoryCount,
        sourceSnapshotObjectKey,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const concurrent = await this.repository.findDeepAnalysisReportsByDayPrefix(
          context.apiKeyFingerprint,
          baseRequestDayKey,
        );
        const existing = concurrent.find((reportItem) => isRunningStatus(reportItem.status)) ?? concurrent[0];
        if (existing) {
          throw buildExistingReportError(existing);
        }
      }
      throw error;
    }

    this.scheduleSourcePreparation({
      reportId: report.id,
      sourceSnapshotObjectKey,
      rawApiKey: context.rawApiKey,
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

  private scheduleSourcePreparation(input: {
    reportId: string;
    sourceSnapshotObjectKey: string;
    rawApiKey: string;
    traceId: string;
  }): void {
    const schedule = typeof setImmediate === 'function'
      ? setImmediate
      : (callback: () => void) => setTimeout(callback, 0);

    schedule(() => {
      void this.prepareSourceSnapshotAndEnqueue(input);
    });
  }

  private async prepareSourceSnapshotAndEnqueue(input: {
    reportId: string;
    sourceSnapshotObjectKey: string;
    rawApiKey: string;
    traceId: string;
  }): Promise<void> {
    try {
      await this.repository.updateDeepAnalysisReport(input.reportId, {
        status: DeepAnalysisReportStatus.PREPARING,
        stage: DeepAnalysisReportStage.FETCH_SOURCE,
        progressPercent: 5,
        startedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      });

      const memories = await this.source.fetchAllMemories(input.rawApiKey);
      await this.storage.putCompressedJson(
        input.sourceSnapshotObjectKey,
        gzipJson({
          fetchedAt: new Date().toISOString(),
          memoryCount: memories.length,
          memories,
        }),
      );

      await this.repository.updateDeepAnalysisReport(input.reportId, {
        memoryCount: memories.length,
        progressPercent: 10,
      });

      await this.queue.enqueueLlmMessage({
        messageType: 'deep_report',
        reportId: input.reportId,
        traceId: input.traceId,
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      const errorCode = appError?.code ?? 'DEEP_ANALYSIS_SOURCE_PREP_FAILED';
      const errorMessage = appError?.message ?? 'Failed to prepare deep analysis source snapshot';

      this.logger.error(`Failed to prepare deep analysis source snapshot for ${input.reportId}`, error instanceof Error ? error.stack : undefined);
      await this.repository.updateDeepAnalysisReport(input.reportId, {
        status: DeepAnalysisReportStatus.FAILED,
        stage: DeepAnalysisReportStage.FETCH_SOURCE,
        progressPercent: 0,
        completedAt: new Date(),
        errorCode,
        errorMessage: errorMessage.slice(0, 512),
      });
    }
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

  public async deleteDuplicateMemories(
    context: Mem9RequestContext,
    reportId: string,
  ): Promise<DeleteDeepAnalysisDuplicatesResponse> {
    const report = await this.repository.getOwnedDeepAnalysisReport(
      reportId,
      context.apiKeyFingerprint,
    );

    if (!report.reportObjectKey) {
      throw new AppError('Deep analysis report is not ready yet', {
        statusCode: 409,
        code: 'DEEP_ANALYSIS_REPORT_NOT_READY',
      });
    }

    const reportPayload = await this.storage.getObjectBuffer(report.reportObjectKey);
    const document = JSON.parse(reportPayload.toString('utf8')) as DeepAnalysisReportDocument;
    const duplicateMemoryIds = [...new Set(
      (document.quality.duplicateClusters ?? []).flatMap((cluster) => cluster.duplicateMemoryIds),
    )];

    if (duplicateMemoryIds.length === 0) {
      return {
        reportId,
        deletedCount: 0,
        deletedMemoryIds: [],
        failedMemoryIds: [],
      };
    }

    const deletion = await this.source.deleteMemories(context.rawApiKey, duplicateMemoryIds);
    return {
      reportId,
      deletedCount: deletion.deletedMemoryIds.length,
      deletedMemoryIds: deletion.deletedMemoryIds,
      failedMemoryIds: deletion.failedMemoryIds,
    };
  }

  public async downloadDuplicateCleanupCsv(
    context: Mem9RequestContext,
    reportId: string,
  ): Promise<{ filename: string; content: string }> {
    const report = await this.repository.getOwnedDeepAnalysisReport(
      reportId,
      context.apiKeyFingerprint,
    );

    if (!report.reportObjectKey) {
      throw new AppError('Deep analysis report is not ready yet', {
        statusCode: 409,
        code: 'DEEP_ANALYSIS_REPORT_NOT_READY',
      });
    }

    const [reportPayload, sourcePayload] = await Promise.all([
      this.storage.getObjectBuffer(report.reportObjectKey),
      this.storage.getObjectBuffer(report.sourceSnapshotObjectKey),
    ]);
    const document = JSON.parse(reportPayload.toString('utf8')) as DeepAnalysisReportDocument;
    const sourceSnapshot = gunzipJson<SourceSnapshotPayload>(sourcePayload);
    const memoryPreviewById = new Map(
      sourceSnapshot.memories.map((memory) => [memory.id, sentencePreview(memory.content)]),
    );

    const rows: DeepAnalysisDuplicateExportRow[] =
      (document.quality.duplicateClusters ?? []).flatMap((cluster, index) =>
        cluster.duplicateMemoryIds.map((duplicateMemoryId) => ({
          duplicateMemoryId,
          clusterIndex: index + 1,
          canonicalPreview: memoryPreviewById.get(cluster.canonicalMemoryId) ?? '',
          duplicatePreview: memoryPreviewById.get(duplicateMemoryId) ?? '',
          reason: 'Duplicate content matched the canonical memory in this cluster.',
        })),
      );

    return {
      filename: buildDuplicateCsvFilename(reportId),
      content: buildDuplicateCsv(rows),
    };
  }
}
