import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type {
  CreateDeepAnalysisReportResponse,
  DeepAnalysisReportDetail,
  DeepAnalysisReportDocument,
  DeepAnalysisReportListItem,
  DeepAnalysisReportPreview,
  ListDeepAnalysisReportsResponse,
} from '@mem9/contracts';
import { AnalysisRepository, S3PayloadStorageService, createPrefixedId } from '@mem9/shared';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { Mem9RequestContext } from './common/request-context';
import { DeepAnalysisDuplicateOpsService } from './deep-analysis-duplicate-ops.service';
import { DeepAnalysisSourcePreparationService } from './deep-analysis-source-preparation.service';
import { DeepAnalysisPolicy } from './deep-analysis.policy';
import type { CreateDeepAnalysisReportDto } from './dto/create-deep-analysis-report.dto';
import type { ListDeepAnalysisReportsDto } from './dto/list-deep-analysis-reports.dto';
import { Mem9SourceService } from './mem9-source.service';

function toPreview(value: unknown): DeepAnalysisReportPreview | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as DeepAnalysisReportPreview;
}

function parseReportDocument(payload: Buffer): DeepAnalysisReportDocument {
  return JSON.parse(payload.toString('utf8')) as DeepAnalysisReportDocument;
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
    private readonly sourcePreparation: DeepAnalysisSourcePreparationService,
    private readonly duplicateOps: DeepAnalysisDuplicateOpsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async createReport(
    context: Mem9RequestContext,
    dto: CreateDeepAnalysisReportDto,
  ): Promise<CreateDeepAnalysisReportResponse> {
    const timezone = DeepAnalysisPolicy.normalizeTimezone(dto.timezone);
    const isProduction = this.config.app.env === 'production';
    const memoryCount = await this.source.countMemories(context.rawApiKey);
    const baseRequestDayKey = DeepAnalysisPolicy.buildRequestDayKey(timezone);
    let existingReports = isProduction
      ? await this.repository.findDeepAnalysisReportsByDayPrefix(
        context.apiKeyFingerprint,
        baseRequestDayKey,
      )
      : [];
    const sourceSnapshotObjectKey = `deep-analysis/reports/${createPrefixedId('snapshot')}/source.json.gz`;

    const resolvePolicy = () => DeepAnalysisPolicy.resolveCreateReport({
      env: this.config.app.env,
      timezone,
      existingReports,
      memoryCount,
      bypassFingerprints: this.config.analysis.deepAnalysisDailyLimitBypassFingerprints,
      apiKeyFingerprintHex: context.apiKeyFingerprintHex,
    });

    let policy = resolvePolicy();
    let report;
    let lastCreateError: unknown = null;
    const maxCreateAttempts = isProduction ? 3 : 1;

    for (let attempt = 0; attempt < maxCreateAttempts; attempt += 1) {
      try {
        report = await this.repository.createDeepAnalysisReport({
          fingerprint: context.apiKeyFingerprint,
          requestDayKey: policy.requestDayKey,
          lang: dto.lang.trim() || 'zh-CN',
          timezone,
          memoryCount,
          sourceSnapshotObjectKey,
        });
        break;
      } catch (error) {
        if (
          !isProduction ||
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        ) {
          throw error;
        }

        lastCreateError = error;
        existingReports = await this.repository.findDeepAnalysisReportsByDayPrefix(
          context.apiKeyFingerprint,
          baseRequestDayKey,
        );
        policy = resolvePolicy();
      }
    }

    if (!report) {
      if (lastCreateError instanceof Error) {
        throw lastCreateError;
      }

      throw new Error('Failed to create deep analysis report');
    }

    this.sourcePreparation.schedule({
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
      document = parseReportDocument(payload);
    }

    return {
      ...toListItem(report),
      report: document,
    };
  }

  public async deleteDuplicateMemories(
    context: Mem9RequestContext,
    reportId: string,
  ) {
    return this.duplicateOps.deleteDuplicateMemories(context, reportId);
  }

  public async deleteReport(
    context: Mem9RequestContext,
    reportId: string,
  ) {
    return this.duplicateOps.deleteReport(context, reportId);
  }

  public async downloadDuplicateCleanupCsv(
    context: Mem9RequestContext,
    reportId: string,
  ) {
    return this.duplicateOps.downloadDuplicateCleanupCsv(context, reportId);
  }
}
