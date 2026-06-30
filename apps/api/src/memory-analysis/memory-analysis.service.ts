import type {
  DeleteSessionMessageEditResponse,
  EditSessionMessageRequest,
  EditSessionMessageResponse,
  GetSessionMessageEditResponse,
  MarkSessionMessageResponse,
} from '@mem9/contracts';
import { AnalysisRepository, AppError, RedisService, SqsQueueService, redisKeys } from '@mem9/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { MemoryReport } from '@prisma/client';

import type { Mem9RequestContext } from '../common/request-context';
import type { CreateMemoryAnalysisReportDto } from '../dto/create-memory-analysis-report.dto';
import type { ListMemoryAnalysisReportsDto } from '../dto/list-memory-analysis-reports.dto';
import { Mem9SourceService } from '../mem9-source.service';

export interface MemoryAnalysisReportResponse {
  report_id: number;
  template_id: string;
  report_content: string | null;
  generated_at: string;
  started_at: string | null;
  completed_at: string | null;
  startTime: string | null;
  endTime: string | null;
  render_status: 'queued' | 'running' | 'fail' | 'success';
  report_stage: 'queued' | 'fetch_source' | 'period_summary' | 'aggregation' | 'save_result' | 'complete' | 'failed';
  fail_code: string | null;
  fail_reason: string | null;
  memory_count: number;
}

const MAX_ANALYSIS_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const MEMORY_ANALYSIS_REPORT_TEMPLATE_ID = 'memory_analysis';

@Injectable()
export class MemoryAnalysisService {
  private readonly logger = new Logger(MemoryAnalysisService.name);

  public constructor(
    private readonly source: Mem9SourceService,
    private readonly repository: AnalysisRepository,
    private readonly queue: SqsQueueService,
    private readonly redis: RedisService,
  ) {}

  public async createReport(
    context: Mem9RequestContext,
    dto: CreateMemoryAnalysisReportDto,
  ): Promise<MemoryAnalysisReportResponse> {
    this.validateDateRange(dto);
    const startTime = new Date(dto.createdAfter);
    const endTime = new Date(dto.createdBefore);
    const existingReport = await this.repository.findActiveMemoryAnalysisReportByWindow({
      fingerprint: context.apiKeyFingerprint,
      templateId: MEMORY_ANALYSIS_REPORT_TEMPLATE_ID,
      startTime,
      endTime,
    });

    if (existingReport !== null) {
      this.logger.log(JSON.stringify({
        event: 'memory_analysis_report_deduplicated',
        reportId: existingReport.reportId,
        renderStatus: existingReport.renderStatus,
        reportStage: existingReport.reportStage,
        apiKeyFingerprint: context.apiKeyFingerprintHex,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      }));
      return this.toReportResponse(existingReport);
    }

    const report = await this.repository.createMemoryAnalysisReport({
      fingerprint: context.apiKeyFingerprint,
      templateId: MEMORY_ANALYSIS_REPORT_TEMPLATE_ID,
      startTime,
      endTime,
      renderStatus: 'queued',
      reportStage: 'queued',
      memoryCount: 0,
    });

    try {
      await this.queue.enqueueLlmMessage({
        messageType: 'memory_analysis_report',
        reportId: report.reportId,
        apiKeyFingerprintHex: context.apiKeyFingerprintHex,
        rawApiKey: context.rawApiKey,
        createdAfter: dto.createdAfter,
        createdBefore: dto.createdBefore,
        traceId: context.requestId,
      });
    } catch (error) {
      const failReason = 'Failed to queue memory analysis report generation. Please retry later.';
      this.logger.error(JSON.stringify({
        event: 'memory_analysis_report_enqueue_failed',
        reportId: report.reportId,
        stage: 'queued',
        apiKeyFingerprint: context.apiKeyFingerprintHex,
        failCode: 'MEMORY_ANALYSIS_QUEUE_ENQUEUE_FAILED',
        failReason,
      }), error instanceof Error ? error.stack : undefined);
      await this.repository.updateMemoryAnalysisReport(report.reportId, {
        renderStatus: 'fail',
        reportStage: 'failed',
        completedAt: new Date(),
        failCode: 'MEMORY_ANALYSIS_QUEUE_ENQUEUE_FAILED',
        failReason,
      });
      throw new AppError(failReason, {
        statusCode: HttpStatus.BAD_GATEWAY,
        code: 'MEMORY_ANALYSIS_QUEUE_ENQUEUE_FAILED',
        cause: error,
      });
    }

    return this.toReportResponse(report);
  }

  public async listReports(
    context: Mem9RequestContext,
    dto: ListMemoryAnalysisReportsDto,
  ): Promise<MemoryAnalysisReportResponse[]> {
    const reports = await this.repository.listMemoryAnalysisReportsByTemplateId(
      context.apiKeyFingerprint,
      dto.type ?? MEMORY_ANALYSIS_REPORT_TEMPLATE_ID,
    );
    return reports.map((report) => this.toReportResponse(report));
  }

  public async getReport(
    context: Mem9RequestContext,
    reportId: string,
  ): Promise<MemoryAnalysisReportResponse | null> {
    if (!/^\d+$/.test(reportId)) {
      return null;
    }

    const parsedReportId = Number(reportId);
    if (!Number.isInteger(parsedReportId) || parsedReportId <= 0) {
      return null;
    }

    const report = await this.repository.findMemoryAnalysisReport(
      context.apiKeyFingerprint,
      parsedReportId,
    );
    return report === null ? null : this.toReportResponse(report);
  }

  public async markSessionMessage(
    context: Mem9RequestContext,
    id: string,
    correctness: string,
  ): Promise<MarkSessionMessageResponse> {
    if (correctness !== 'correct' && correctness !== 'incorrect') {
      throw new AppError("Session message correctness must be 'correct' or 'incorrect'", {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'SESSION_MESSAGE_MARK_INVALID',
      });
    }

    const memory = await this.source.fetchMemoryById(context.rawApiKey, id);
    const result = await this.source.markSessionMessage(context.rawApiKey, id, correctness);
    await this.invalidatePeriodCacheForTimestamp(context, memory.createdAt);

    return result;
  }

  public async editSessionMessage(
    context: Mem9RequestContext,
    id: string,
    input: EditSessionMessageRequest,
  ): Promise<EditSessionMessageResponse> {
    if (input.content.trim().length === 0) {
      throw new AppError('Session message edit content is required', {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'SESSION_MESSAGE_EDIT_CONTENT_REQUIRED',
      });
    }

    const result = await this.source.editSessionMessage(context.rawApiKey, id, input);
    const invalidatedPeriodKey = await this.invalidatePeriodCacheForTimestamp(
      context,
      result.session.createdAt,
    );

    return {
      ...result,
      invalidatedPeriodKey,
    };
  }

  public async getSessionMessageEdit(
    context: Mem9RequestContext,
    id: string,
  ): Promise<GetSessionMessageEditResponse> {
    return this.source.getSessionMessageEdit(context.rawApiKey, id);
  }

  public async deleteSessionMessageEdit(
    context: Mem9RequestContext,
    id: string,
  ): Promise<DeleteSessionMessageEditResponse> {
    const memory = await this.source.fetchMemoryById(context.rawApiKey, id);
    const result = await this.source.deleteSessionMessageEdit(context.rawApiKey, id);
    const invalidatedPeriodKey = await this.invalidatePeriodCacheForTimestamp(
      context,
      memory.createdAt,
    );

    return {
      ...result,
      invalidatedPeriodKey,
    };
  }

  private async invalidatePeriodCacheForTimestamp(
    context: Mem9RequestContext,
    timestamp: string | undefined,
  ): Promise<string | null> {
    const periodKey = this.toDayKey(timestamp);
    if (periodKey === 'unknown-date') {
      return null;
    }

    try {
      const fingerprintHex = context.apiKeyFingerprintHex ?? context.apiKeyFingerprint.toString('hex');
      const indexKey = redisKeys.memoryAnalysisPeriodCacheIndex(fingerprintHex, periodKey);
      const cacheKeys = await this.redis.smembers(indexKey);
      if (cacheKeys.length > 0) {
        await this.redis.del(...cacheKeys, indexKey);
      } else {
        await this.redis.del(indexKey);
      }
    } catch (error) {
      throw new AppError('Failed to invalidate memory analysis cache', {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'MEMORY_ANALYSIS_CACHE_INVALIDATION_FAILED',
        details: {
          periodKey,
        },
        cause: error,
      });
    }

    return periodKey;
  }

  private validateDateRange(dto: CreateMemoryAnalysisReportDto): void {
    const createdAfter = dto.createdAfter?.trim();
    const createdBefore = dto.createdBefore?.trim();

    if (!createdAfter || !createdBefore) {
      throw new AppError('createdAfter and createdBefore are required', {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'MEMORY_ANALYSIS_DATE_RANGE_REQUIRED',
      });
    }

    const start = new Date(createdAfter);
    const end = new Date(createdBefore);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new AppError('createdAfter and createdBefore must be valid ISO 8601 timestamps', {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'MEMORY_ANALYSIS_INVALID_DATE_RANGE',
      });
    }

    if (start >= end) {
      throw new AppError('createdAfter must be before createdBefore', {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'MEMORY_ANALYSIS_INVALID_DATE_RANGE',
      });
    }

    if (end.getTime() - start.getTime() > MAX_ANALYSIS_RANGE_MS) {
      throw new AppError('Memory analysis date range supports at most 14 days', {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'MEMORY_ANALYSIS_DATE_RANGE_TOO_LARGE',
        details: {
          maximumDays: 14,
        },
      });
    }

    dto.createdAfter = createdAfter;
    dto.createdBefore = createdBefore;
  }

  private toDayKey(value?: string): string {
    if (!value) {
      return 'unknown-date';
    }

    const datePart = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : 'unknown-date';
  }

  private toReportResponse(report: MemoryReport): MemoryAnalysisReportResponse {
    const renderStatus = this.normalizeReportStatus(report.renderStatus);

    return {
      report_id: report.reportId,
      template_id: report.templateId,
      report_content: renderStatus === 'success' ? report.reportContent : null,
      generated_at: report.generatedAt.toISOString(),
      started_at: report.startedAt?.toISOString() ?? null,
      completed_at: report.completedAt?.toISOString() ?? null,
      startTime: report.startTime?.toISOString() ?? null,
      endTime: report.endTime?.toISOString() ?? null,
      render_status: renderStatus,
      report_stage: this.normalizeReportStage(report.reportStage),
      fail_code: report.failCode,
      fail_reason: report.failReason,
      memory_count: report.memoryCount,
    };
  }

  private normalizeReportStatus(value: string): MemoryAnalysisReportResponse['render_status'] {
    if (value === 'queued' || value === 'running' || value === 'fail' || value === 'success') {
      return value;
    }

    return value === 'failed' ? 'fail' : 'success';
  }

  private normalizeReportStage(value: string): MemoryAnalysisReportResponse['report_stage'] {
    if (
      value === 'queued'
      || value === 'fetch_source'
      || value === 'period_summary'
      || value === 'aggregation'
      || value === 'save_result'
      || value === 'complete'
      || value === 'failed'
    ) {
      return value;
    }

    return 'complete';
  }
}
