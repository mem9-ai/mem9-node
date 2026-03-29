import type {
  DeepAnalysisDuplicateCleanupStatus,
  DeepAnalysisDuplicateExportRow,
  DeepAnalysisReportDocument,
  DeepAnalysisReportPreview,
  DeleteDeepAnalysisDuplicatesResponse,
} from '@mem9/contracts';
import {
  AnalysisRepository,
  AppError,
  S3PayloadStorageService,
  gunzipJson,
} from '@mem9/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { Mem9RequestContext } from './common/request-context';
import { DeepAnalysisPolicy } from './deep-analysis.policy';
import { Mem9SourceService } from './mem9-source.service';

interface SourceSnapshotPayload {
  fetchedAt: string;
  memoryCount: number;
  memories: Array<{
    id: string;
    content: string;
  }>;
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

const ACTIVE_DUPLICATE_CLEANUP_STATUSES = new Set<
  DeepAnalysisDuplicateCleanupStatus['status']
>(['QUEUED', 'RUNNING']);
const STALE_DUPLICATE_CLEANUP_MS = 30 * 60 * 1000;

interface DeepAnalysisReportRecordLike {
  id: string;
  status: string;
  reportObjectKey: string | null;
  sourceSnapshotObjectKey: string;
  previewJson?: unknown;
  requestedAt?: Date;
  completedAt?: Date | null;
}

interface ScheduleDuplicateCleanupInput {
  reportId: string;
  rawApiKey: string;
  duplicateMemoryIds: string[];
}

function toPreview(value: unknown): DeepAnalysisReportPreview | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as DeepAnalysisReportPreview;
}

function getDuplicateCleanupStatus(
  report: Pick<DeepAnalysisReportRecordLike, 'previewJson'>,
): DeepAnalysisDuplicateCleanupStatus | null {
  return toPreview(report.previewJson)?.duplicateCleanup ?? null;
}

function isDuplicateCleanupActive(
  cleanup: DeepAnalysisDuplicateCleanupStatus | null,
): cleanup is DeepAnalysisDuplicateCleanupStatus {
  return cleanup !== null && ACTIVE_DUPLICATE_CLEANUP_STATUSES.has(cleanup.status);
}

function isDuplicateCleanupStale(cleanup: DeepAnalysisDuplicateCleanupStatus): boolean {
  const anchor = cleanup.startedAt ?? cleanup.requestedAt;
  const timestamp = Date.parse(anchor);
  return Number.isNaN(timestamp) || Date.now() - timestamp > STALE_DUPLICATE_CLEANUP_MS;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function buildPreviewWithDuplicateCleanup(
  report: DeepAnalysisReportRecordLike,
  cleanup: DeepAnalysisDuplicateCleanupStatus,
): Prisma.InputJsonValue {
  const preview = toPreview(report.previewJson);
  return {
    ...preview,
    generatedAt:
      typeof preview?.generatedAt === 'string'
        ? preview.generatedAt
        : report.completedAt?.toISOString() ?? report.requestedAt?.toISOString() ?? new Date().toISOString(),
    summary: typeof preview?.summary === 'string' ? preview.summary : '',
    topThemes: normalizeStringArray(preview?.topThemes),
    keyRecommendations: normalizeStringArray(preview?.keyRecommendations),
    duplicateCleanup: cleanup,
  } as unknown as Prisma.InputJsonValue;
}

function collectDuplicateMemoryIds(
  document: DeepAnalysisReportDocument,
  deletedMemoryIds: string[],
): string[] {
  const deletedIds = new Set(deletedMemoryIds);
  return [...new Set(
    (document.quality.duplicateClusters ?? []).flatMap((cluster) => cluster.duplicateMemoryIds),
  )].filter((memoryId) => !deletedIds.has(memoryId));
}

@Injectable()
export class DeepAnalysisDuplicateOpsService {
  private readonly logger = new Logger(DeepAnalysisDuplicateOpsService.name);
  private readonly scheduledCleanupReports = new Set<string>();

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly source: Mem9SourceService,
    private readonly storage: S3PayloadStorageService,
  ) {}

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
    const existingCleanup = getDuplicateCleanupStatus(report);

    if (isDuplicateCleanupActive(existingCleanup) && !isDuplicateCleanupStale(existingCleanup)) {
      return {
        reportId,
        duplicateCleanup: existingCleanup,
      };
    }

    const previousDeletedMemoryIds = existingCleanup?.deletedMemoryIds ?? [];
    const duplicateMemoryIds = collectDuplicateMemoryIds(document, previousDeletedMemoryIds);

    if (duplicateMemoryIds.length === 0) {
      const duplicateCleanup: DeepAnalysisDuplicateCleanupStatus = {
        status: 'COMPLETED',
        requestedAt: existingCleanup?.requestedAt ?? new Date().toISOString(),
        startedAt: existingCleanup?.startedAt ?? null,
        completedAt: new Date().toISOString(),
        totalCount: 0,
        deletedCount: 0,
        failedCount: 0,
        deletedMemoryIds: previousDeletedMemoryIds,
        failedMemoryIds: [],
        errorMessage: null,
      };
      await this.repository.updateDeepAnalysisReport(reportId, {
        previewJson: buildPreviewWithDuplicateCleanup(report, duplicateCleanup),
      });
      return {
        reportId,
        duplicateCleanup,
      };
    }

    const duplicateCleanup: DeepAnalysisDuplicateCleanupStatus = {
      status: 'QUEUED',
      requestedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      totalCount: duplicateMemoryIds.length,
      deletedCount: 0,
      failedCount: 0,
      deletedMemoryIds: previousDeletedMemoryIds,
      failedMemoryIds: [],
      errorMessage: null,
    };

    await this.repository.updateDeepAnalysisReport(reportId, {
      previewJson: buildPreviewWithDuplicateCleanup(report, duplicateCleanup),
    });
    this.scheduleDuplicateCleanup({
      reportId,
      rawApiKey: context.rawApiKey,
      duplicateMemoryIds,
    });

    return {
      reportId,
      duplicateCleanup,
    };
  }

  public async deleteReport(
    context: Mem9RequestContext,
    reportId: string,
  ): Promise<{ reportId: string }> {
    const report = await this.repository.getOwnedDeepAnalysisReport(
      reportId,
      context.apiKeyFingerprint,
    );

    if (!DeepAnalysisPolicy.isTerminalStatus(report.status)) {
      throw new AppError('Cannot delete a deep analysis report while it is still running', {
        statusCode: 409,
        code: 'DEEP_ANALYSIS_REPORT_RUNNING',
      });
    }

    const duplicateCleanup = getDuplicateCleanupStatus(report);
    if (isDuplicateCleanupActive(duplicateCleanup) && !isDuplicateCleanupStale(duplicateCleanup)) {
      throw new AppError('Cannot delete a deep analysis report while duplicate cleanup is running', {
        statusCode: 409,
        code: 'DEEP_ANALYSIS_DUPLICATE_CLEANUP_RUNNING',
      });
    }

    await Promise.all([
      report.reportObjectKey ? this.storage.deleteObject(report.reportObjectKey) : Promise.resolve(),
      this.storage.deleteObject(report.sourceSnapshotObjectKey),
    ]);

    await this.repository.deleteDeepAnalysisReport(report.id);

    return {
      reportId,
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

  private scheduleDuplicateCleanup(input: ScheduleDuplicateCleanupInput): void {
    if (this.scheduledCleanupReports.has(input.reportId)) {
      return;
    }

    this.scheduledCleanupReports.add(input.reportId);
    const schedule = typeof setImmediate === 'function'
      ? setImmediate
      : (callback: () => void) => setTimeout(callback, 0);

    schedule(() => {
      void this.runDuplicateCleanup(input);
    });
  }

  private async runDuplicateCleanup(input: ScheduleDuplicateCleanupInput): Promise<void> {
    try {
      const report = await this.repository.getDeepAnalysisReport(input.reportId);
      const queuedCleanup = getDuplicateCleanupStatus(report);
      const runningCleanup: DeepAnalysisDuplicateCleanupStatus = {
        status: 'RUNNING',
        requestedAt: queuedCleanup?.requestedAt ?? new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        totalCount: input.duplicateMemoryIds.length,
        deletedCount: 0,
        failedCount: 0,
        deletedMemoryIds: queuedCleanup?.deletedMemoryIds ?? [],
        failedMemoryIds: [],
        errorMessage: null,
      };

      await this.repository.updateDeepAnalysisReport(input.reportId, {
        previewJson: buildPreviewWithDuplicateCleanup(report, runningCleanup),
      });

      const deletion = await this.source.deleteMemories(input.rawApiKey, input.duplicateMemoryIds);
      const completedReport = await this.repository.getDeepAnalysisReport(input.reportId);
      const latestCleanup = getDuplicateCleanupStatus(completedReport);
      const completedCleanup: DeepAnalysisDuplicateCleanupStatus = {
        status: 'COMPLETED',
        requestedAt: latestCleanup?.requestedAt ?? runningCleanup.requestedAt,
        startedAt: latestCleanup?.startedAt ?? runningCleanup.startedAt,
        completedAt: new Date().toISOString(),
        totalCount: runningCleanup.totalCount,
        deletedCount: deletion.deletedMemoryIds.length,
        failedCount: deletion.failedMemoryIds.length,
        deletedMemoryIds: [...new Set([
          ...(latestCleanup?.deletedMemoryIds ?? runningCleanup.deletedMemoryIds),
          ...deletion.deletedMemoryIds,
        ])],
        failedMemoryIds: deletion.failedMemoryIds,
        errorMessage: null,
      };

      await this.repository.updateDeepAnalysisReport(input.reportId, {
        previewJson: buildPreviewWithDuplicateCleanup(completedReport, completedCleanup),
      });
    } catch (error) {
      this.logger.error(
        `Failed to delete duplicate memories for ${input.reportId}`,
        error instanceof Error ? error.stack : undefined,
      );

      try {
        const report = await this.repository.getDeepAnalysisReport(input.reportId);
        const currentCleanup = getDuplicateCleanupStatus(report);
        const failedCleanup: DeepAnalysisDuplicateCleanupStatus = {
          status: 'FAILED',
          requestedAt: currentCleanup?.requestedAt ?? new Date().toISOString(),
          startedAt: currentCleanup?.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          totalCount: currentCleanup?.totalCount ?? input.duplicateMemoryIds.length,
          deletedCount: currentCleanup?.deletedCount ?? 0,
          failedCount: currentCleanup?.failedCount ?? input.duplicateMemoryIds.length,
          deletedMemoryIds: currentCleanup?.deletedMemoryIds ?? [],
          failedMemoryIds: currentCleanup?.failedMemoryIds ?? input.duplicateMemoryIds,
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 512)
              : 'Failed to delete duplicate memories',
        };
        await this.repository.updateDeepAnalysisReport(input.reportId, {
          previewJson: buildPreviewWithDuplicateCleanup(report, failedCleanup),
        });
      } catch (updateError) {
        this.logger.error(
          `Failed to persist duplicate cleanup failure state for ${input.reportId}`,
          updateError instanceof Error ? updateError.stack : undefined,
        );
      }
    } finally {
      this.scheduledCleanupReports.delete(input.reportId);
    }
  }
}
