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
  normalizeMemoryContent,
  sha256Hex,
} from '@mem9/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { Mem9RequestContext } from './common/request-context';
import { DeepAnalysisPolicy } from './deep-analysis.policy';
import { Mem9SourceService } from './mem9-source.service';

interface SourceSnapshotPayload {
  fetchedAt: string;
  memoryCount: number;
  memories: {
    id: string;
    content: string;
  }[];
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
const DUPLICATE_VERIFICATION_CONCURRENCY = 4;

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
  verifiedDuplicates: VerifiedDuplicate[];
  requestId: string;
  apiKeyFingerprintHex: string;
}

interface VerifiedDuplicate {
  canonicalMemoryId: string;
  duplicateMemoryId: string;
  contentHash: string;
  clusterIndex: number;
}

function unverifiedDuplicates(): AppError {
  return new AppError('Duplicate contents could not be verified. Generate a new report before retrying cleanup.', {
    statusCode: 409,
    code: 'DEEP_ANALYSIS_DUPLICATES_UNVERIFIED',
  });
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

function verifyDuplicateClusters(
  document: DeepAnalysisReportDocument,
  snapshot: SourceSnapshotPayload,
  deletedMemoryIds: string[] = [],
): VerifiedDuplicate[] {
  const clusters = document?.quality?.duplicateClusters;
  if (!Array.isArray(clusters) || !Array.isArray(snapshot?.memories)) {
    throw unverifiedDuplicates();
  }
  const contentById = new Map<string, string>();
  for (const memory of snapshot.memories) {
    if (!memory || typeof memory.id !== 'string' || typeof memory.content !== 'string' || contentById.has(memory.id)) {
      throw unverifiedDuplicates();
    }
    contentById.set(memory.id, normalizeMemoryContent(memory.content));
  }
  // Reserve every canonical across all clusters, including legacy model output.
  // Otherwise overlapping/cyclic clusters could delete the last retained copy.
  const canonicalIds = new Set(clusters.map(cluster => cluster?.canonicalMemoryId));
  const deletedIds = new Set(deletedMemoryIds);
  const verified = new Map<string, VerifiedDuplicate>();
  for (const [index, cluster] of clusters.entries()) {
    if (!cluster || typeof cluster.canonicalMemoryId !== 'string' || !Array.isArray(cluster.duplicateMemoryIds)) {
      throw unverifiedDuplicates();
    }
    const content = contentById.get(cluster.canonicalMemoryId);
    if (!content || deletedIds.has(cluster.canonicalMemoryId)) {
      throw unverifiedDuplicates();
    }
    for (const id of cluster.duplicateMemoryIds) {
      if (typeof id !== 'string' || canonicalIds.has(id) || contentById.get(id) !== content) {
        throw unverifiedDuplicates();
      }
      if (!deletedIds.has(id)) {
        verified.set(id, {
          canonicalMemoryId: cluster.canonicalMemoryId,
          duplicateMemoryId: id,
          contentHash: sha256Hex(content),
          clusterIndex: index + 1,
        });
      }
    }
  }
  return [...verified.values()];
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
    const sourcePayload = await this.storage.getObjectBuffer(report.sourceSnapshotObjectKey);
    const verifiedDuplicates = verifyDuplicateClusters(
      document, gunzipJson<SourceSnapshotPayload>(sourcePayload), previousDeletedMemoryIds,
    );
    const duplicateMemoryIds = verifiedDuplicates.map(item => item.duplicateMemoryId);

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
      verifiedDuplicates,
      requestId: context.requestId,
      apiKeyFingerprintHex: context.apiKeyFingerprintHex,
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
      verifyDuplicateClusters(document, sourceSnapshot).map((item) => ({
        duplicateMemoryId: item.duplicateMemoryId,
        clusterIndex: item.clusterIndex,
        canonicalPreview: memoryPreviewById.get(item.canonicalMemoryId) ?? '',
        duplicatePreview: memoryPreviewById.get(item.duplicateMemoryId) ?? '',
        reason: 'Duplicate content matched the canonical memory in this cluster.',
      }));

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
    const auditContext = {
      requestId: input.requestId,
      reportId: input.reportId,
      apiKeyFingerprintHex: input.apiKeyFingerprintHex,
      requestedCount: input.duplicateMemoryIds.length,
    };
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

      this.logger.log(JSON.stringify({ event: 'duplicate_cleanup_started', ...auditContext }));
      // Verify the entire batch before the first DELETE, using the caller's key.
      // Snapshot checks alone cannot protect memories edited since the report.
      const expectedHashes = new Map<string, string>();
      for (const item of input.verifiedDuplicates) {
        expectedHashes.set(item.canonicalMemoryId, item.contentHash);
        expectedHashes.set(item.duplicateMemoryId, item.contentHash);
      }
      const entries = [...expectedHashes];
      for (let offset = 0; offset < entries.length; offset += DUPLICATE_VERIFICATION_CONCURRENCY) {
        await Promise.all(entries.slice(offset, offset + DUPLICATE_VERIFICATION_CONCURRENCY).map(async ([id, expectedHash]) => {
          const memory = await this.source.fetchMemoryById(input.rawApiKey, id);
          if (memory.id !== id || sha256Hex(normalizeMemoryContent(memory.content)) !== expectedHash) {
            throw unverifiedDuplicates();
          }
        }));
      }
      const deletion = await this.source.deleteMemories(input.rawApiKey, input.duplicateMemoryIds);
      this.logger.log(JSON.stringify({
        event: 'duplicate_cleanup_result', ...auditContext,
        deletedCount: deletion.deletedMemoryIds.length,
        failedCount: deletion.failedMemoryIds.length,
      }));
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
      this.logger.error(JSON.stringify({ event: 'duplicate_cleanup_failed', ...auditContext }));
      this.logger.error(
        `Failed to delete duplicate memories for ${input.reportId}`,
        error instanceof Error ? error.stack : undefined,
      );

      try {
        const report = await this.repository.getDeepAnalysisReport(input.reportId);
        const currentCleanup = getDuplicateCleanupStatus(report);
        const deletedMemoryIds = currentCleanup?.deletedMemoryIds ?? [];
        const failedMemoryIds = input.duplicateMemoryIds.filter(id => !deletedMemoryIds.includes(id));
        const failedCleanup: DeepAnalysisDuplicateCleanupStatus = {
          status: 'FAILED',
          requestedAt: currentCleanup?.requestedAt ?? new Date().toISOString(),
          startedAt: currentCleanup?.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          totalCount: currentCleanup?.totalCount ?? input.duplicateMemoryIds.length,
          deletedCount: currentCleanup?.deletedCount ?? 0,
          failedCount: failedMemoryIds.length,
          deletedMemoryIds,
          failedMemoryIds,
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
