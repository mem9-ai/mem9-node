import type {
  DeepAnalysisDuplicateExportRow,
  DeepAnalysisReportDocument,
} from '@mem9/contracts';
import {
  AnalysisRepository,
  AppError,
  S3PayloadStorageService,
  gunzipJson,
} from '@mem9/shared';
import { Injectable } from '@nestjs/common';

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

@Injectable()
export class DeepAnalysisDuplicateOpsService {
  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly source: Mem9SourceService,
    private readonly storage: S3PayloadStorageService,
  ) {}

  public async deleteDuplicateMemories(
    context: Mem9RequestContext,
    reportId: string,
  ): Promise<{
    reportId: string;
    deletedCount: number;
    deletedMemoryIds: string[];
    failedMemoryIds: string[];
  }> {
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
}
