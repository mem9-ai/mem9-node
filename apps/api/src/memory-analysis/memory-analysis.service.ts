import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';
import type {
  DeleteSessionMessageEditResponse,
  EditSessionMessageRequest,
  EditSessionMessageResponse,
  GetSessionMessageEditResponse,
  MarkSessionMessageResponse,
  SessionMessageCorrectness,
} from '@mem9/contracts';
import { AnalysisRepository, AppError } from '@mem9/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MemoryReport } from '@prisma/client';

import type { Mem9RequestContext } from '../common/request-context';
import type { AnalyzeMemorySourceDto } from '../dto/analyze-memory-source.dto';
import type { CreateMemoryAnalysisReportDto } from '../dto/create-memory-analysis-report.dto';
import type { ListMemoryAnalysisReportsDto } from '../dto/list-memory-analysis-reports.dto';
import { Mem9SourceService } from '../mem9-source.service';

import {
  MEMORY_CHANGE_AGGREGATION_SYSTEM_PROMPT,
  MEMORY_PERIOD_SUMMARY_PROMPT_VERSION,
  MEMORY_PERIOD_SUMMARY_SYSTEM_PROMPT,
} from './prompts';
import type {
  AnalyzeMemorySourceChangesResponse,
  AnalyzeMemorySourcePeriodSummaryResponse,
  MemoryAnalysisChange,
  MemoryAnalysisChangeDimensionGroup,
  MemoryAnalysisChangeEvidence,
  MemoryAnalysisPeriodDimensionGroup,
  MemoryAnalysisPeriodInsight,
  MemoryAnalysisPeriodInsightEvidence,
  MemoryAnalysisPeriodSummary,
  MemoryAnalysisReportResponse,
  MemorySignalDimension,
  PromptMemory,
  PromptPeriod,
} from './types';
import { MEMORY_ANALYSIS_DIMENSIONS } from './types';

interface QwenChatCompletionPayload {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  choices?: {
    message?: {
      content?: string;
    };
  }[];
  error?: {
    code?: string;
    message?: string;
  };
}

interface RawPeriodSummaryResult {
  periods?: unknown;
}

interface RawChangeAggregationResult {
  dimensions?: unknown;
  d?: unknown;
}

interface QwenJsonCompletionInput {
  event: string;
  systemPrompt: string;
  userContent: string;
  logMetadata: Record<string, number | string | null>;
  timeoutLogMessage: string;
}

const MAX_CONTENT_CHARS = 12000;
const MAX_BATCH_CONTENT_CHARS = 60000;
const MAX_INSIGHTS_PER_DIMENSION_PER_PERIOD = 3;
const MAX_EVIDENCE_PER_INSIGHT = 1;
const MAX_EVIDENCE_PER_CHANGE = 3;
const QWEN_PERIOD_SUMMARY_CONCURRENCY = 5;
const MAX_ANALYSIS_RANGE_MS = 14 * 24 * 60 * 60 * 1000;

@Injectable()
export class MemoryAnalysisService {
  private readonly logger = new Logger(MemoryAnalysisService.name);

  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly source: Mem9SourceService,
    private readonly repository: AnalysisRepository,
  ) {}

  public async analyzeSource(
    context: Mem9RequestContext,
    dto: AnalyzeMemorySourceDto,
  ): Promise<AnalyzeMemorySourceChangesResponse> {
    const startedAt = Date.now();
    this.validateDateRange(dto);
    const firstPass = await this.summarizeSourcePeriods(context, dto);

    const aggregationStartedAt = Date.now();
    const dimensions = await this.aggregateChangeDimensions(firstPass.periods);
    const aggregationDurationMs = Date.now() - aggregationStartedAt;
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_completed',
      durationMs: Date.now() - startedAt,
      aggregationDurationMs,
      total: firstPass.total,
      periodCount: firstPass.periods.length,
      insightCount: this.countPeriodInsights(firstPass.periods.flatMap((period) => period.dimensions)),
      changeCount: this.countChanges(dimensions),
      dimensionCount: dimensions.length,
    }));

    return {
      total: firstPass.total,
      memoryCount: firstPass.memoryCount,
      model: firstPass.model,
      dimensions,
    };
  }

  public async createReport(
    context: Mem9RequestContext,
    dto: CreateMemoryAnalysisReportDto,
  ): Promise<MemoryAnalysisReportResponse> {
    const report = await this.repository.createMemoryAnalysisReport({
      fingerprint: context.apiKeyFingerprint,
      templateId: dto.template_id,
      reportContent: dto.report_content,
      renderStatus: dto.render_status,
      failReason: dto.fail_reason,
      memoryCount: dto.memory_count,
    });

    return this.toReportResponse(report);
  }

  public async listReports(
    context: Mem9RequestContext,
    dto: ListMemoryAnalysisReportsDto,
  ): Promise<MemoryAnalysisReportResponse[]> {
    const reports = await this.repository.listMemoryAnalysisReportsByTemplateId(
      context.apiKeyFingerprint,
      dto.type,
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

  private async summarizeSourcePeriods(
    context: Mem9RequestContext,
    dto: AnalyzeMemorySourceDto,
  ): Promise<AnalyzeMemorySourcePeriodSummaryResponse> {
    const fetchStartedAt = Date.now();
    const memories = await this.source.fetchSessionMemories(context.rawApiKey, {
      createdAfter: dto.createdAfter,
      createdBefore: dto.createdBefore,
    });
    const fetchDurationMs = Date.now() - fetchStartedAt;
    const promptStartedAt = Date.now();
    const periods = this.buildPromptPeriods(memories, dto);
    const promptDurationMs = Date.now() - promptStartedAt;
    const promptMemories = periods.flatMap((period) => period.memories);
    const promptContentChars = promptMemories.reduce((count, memory) => count + memory.text.length, 0);
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_source_prepared',
      fetchDurationMs,
      promptDurationMs,
      total: memories.length,
      returnedMemories: memories.length,
      promptPeriods: periods.length,
      promptMemories: promptMemories.length,
      promptContentChars,
      maxPromptMemoryChars: Math.max(0, ...promptMemories.map((memory) => memory.text.length)),
    }));

    if (periods.length === 0) {
      return {
        total: memories.length,
        memoryCount: memories.length,
        model: this.config.analysis.qwenModel ?? '',
        periods: [],
      };
    }

    this.ensureQwenConfigured();

    const qwenStartedAt = Date.now();
    const periodResults = await this.summarizePromptPeriods(context.apiKeyFingerprint, periods);
    const normalizedPeriods = periodResults.flatMap((result) => result.periods);
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_periods_normalized',
      qwenDurationMs: Date.now() - qwenStartedAt,
      responseChars: periodResults.reduce((count, result) => count + result.responseChars, 0),
      cacheHits: periodResults.filter((result) => result.cacheHit).length,
      cacheMisses: periodResults.filter((result) => !result.cacheHit).length,
      periodCount: normalizedPeriods.length,
      insightCount: this.countPeriodInsights(normalizedPeriods.flatMap((period) => period.dimensions)),
    }));

    return {
      total: memories.length,
      memoryCount: memories.length,
      model: this.config.analysis.qwenModel!,
      periods: normalizedPeriods,
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
      await this.repository.invalidateMemoryAnalysisPeriodCache({
        fingerprint: context.apiKeyFingerprint,
        periodKey,
      });
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

  private async summarizePromptPeriods(
    apiKeyFingerprint: Buffer,
    periods: PromptPeriod[],
  ): Promise<{ periods: MemoryAnalysisPeriodSummary[]; responseChars: number; cacheHit: boolean }[]> {
    return this.mapWithConcurrency(
      periods,
      QWEN_PERIOD_SUMMARY_CONCURRENCY,
      async (period) => {
        const model = this.config.analysis.qwenModel!;
        const cached = period.cacheable
          ? await this.repository.findMemoryAnalysisPeriodCache({
            fingerprint: apiKeyFingerprint,
            periodKey: period.periodKey,
            model,
            promptVersion: MEMORY_PERIOD_SUMMARY_PROMPT_VERSION,
          })
          : null;

        if (cached) {
          return {
            periods: [this.normalizeCachedPeriodSummary(cached.resultJson, period)],
            responseChars: 0,
            cacheHit: true,
          };
        }

        const content = await this.callQwenForPeriodSummaries([period]);
        const parsed = this.parseJsonObject(content);
        const normalizedPeriods = this.normalizePeriodSummaryResult(parsed, [period]);
        if (period.cacheable) {
          await this.repository.upsertMemoryAnalysisPeriodCache({
            fingerprint: apiKeyFingerprint,
            periodKey: period.periodKey,
            model,
            promptVersion: MEMORY_PERIOD_SUMMARY_PROMPT_VERSION,
            resultJson: normalizedPeriods[0] as unknown as Prisma.InputJsonValue,
          });
        }

        return {
          periods: normalizedPeriods,
          responseChars: content.length,
          cacheHit: false,
        };
      },
    );
  }

  private async aggregateChangeDimensions(
    periods: MemoryAnalysisPeriodSummary[],
  ): Promise<MemoryAnalysisChangeDimensionGroup[]> {
    if (periods.length === 0) {
      return [];
    }

    const content = await this.callQwenForChangeAggregation(periods);
    const parsed = this.parseChangeAggregationJsonObject(content);
    const dimensions = this.normalizeChangeAggregationResult(parsed, periods);

    if (dimensions.length === 0) {
      this.logger.warn('Memory analysis change aggregation returned no dimensions; falling back to direct period mapping');
      return this.buildChangeDimensions(periods);
    }

    return dimensions;
  }

  private buildChangeDimensions(periods: MemoryAnalysisPeriodSummary[]): MemoryAnalysisChangeDimensionGroup[] {
    const changesByDimension = new Map<MemorySignalDimension, MemoryAnalysisChange[]>();
    const sortedPeriods = [...periods].sort((left, right) => (
      left.period.start.localeCompare(right.period.start)
      || left.period.end.localeCompare(right.period.end)
    ));

    for (const period of sortedPeriods) {
      for (const group of period.dimensions) {
        const changes = changesByDimension.get(group.dimension) ?? [];
        for (const insight of group.insights) {
          const evidence = this.toChangeEvidence(insight.evidence);
          if (evidence.length === 0) {
            continue;
          }

          changes.push({
            title: insight.title,
            summary: insight.summary,
            period: {
              start: period.period.start,
              end: period.period.end,
            },
            evidence,
          });
        }
        changesByDimension.set(group.dimension, changes);
      }
    }

    return [...MEMORY_ANALYSIS_DIMENSIONS]
      .map((dimension): MemoryAnalysisChangeDimensionGroup | null => {
        const changes = (changesByDimension.get(dimension) ?? []).sort((left, right) => (
          left.period.start.localeCompare(right.period.start)
          || left.period.end.localeCompare(right.period.end)
        ));

        return changes.length > 0
          ? { dimension, changes }
          : null;
      })
      .filter((group): group is MemoryAnalysisChangeDimensionGroup => group !== null);
  }

  private toChangeEvidence(evidence: MemoryAnalysisPeriodInsightEvidence[]): MemoryAnalysisChangeEvidence[] {
    const uniqueEvidence: MemoryAnalysisChangeEvidence[] = [];
    const seenIds = new Set<string>();

    for (const item of evidence) {
      if (seenIds.has(item.evidenceId)) {
        continue;
      }
      seenIds.add(item.evidenceId);
      uniqueEvidence.push({
        evidenceId: item.evidenceId,
        quote: item.quote,
        ...this.pickEvidenceReview(item),
      });
    }

    return uniqueEvidence;
  }

  private async mapWithConcurrency<TItem, TResult>(
    items: TItem[],
    concurrency: number,
    worker: (item: TItem) => Promise<TResult>,
  ): Promise<TResult[]> {
    const results: TResult[] = [];
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex]!);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private validateDateRange(dto: AnalyzeMemorySourceDto): void {
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

  private ensureQwenConfigured(): void {
    if (!this.config.analysis.qwenApiKey) {
      throw new AppError('Qwen API key is not configured', {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'QWEN_NOT_CONFIGURED',
      });
    }

    if (!this.config.analysis.qwenModel) {
      throw new AppError('Qwen model is not configured', {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'QWEN_NOT_CONFIGURED',
      });
    }
  }

  private async callQwenForPeriodSummaries(
    periods: PromptPeriod[],
  ): Promise<string> {
    const userContent = JSON.stringify({
      periods: periods.map((period) => ({
        periodKey: period.periodKey,
        start: period.start,
        end: period.end,
        memories: period.memories,
      })),
    });

    return this.callQwenJsonCompletion({
      event: 'memory_analysis_qwen_completed',
      systemPrompt: MEMORY_PERIOD_SUMMARY_SYSTEM_PROMPT,
      userContent,
      logMetadata: {
        periodCount: periods.length,
        memoryCount: periods.reduce((count, period) => count + period.memories.length, 0),
      },
      timeoutLogMessage: 'Qwen memory period summary request timed out',
    });
  }

  private async callQwenForChangeAggregation(
    periods: MemoryAnalysisPeriodSummary[],
  ): Promise<string> {
    const userContent = JSON.stringify({
      p: this.toChangeAggregationPromptPeriods(periods),
    });

    return this.callQwenJsonCompletion({
      event: 'memory_analysis_change_aggregation_qwen_completed',
      systemPrompt: MEMORY_CHANGE_AGGREGATION_SYSTEM_PROMPT,
      userContent,
      logMetadata: {
        periodCount: periods.length,
        insightCount: this.countPeriodInsights(periods.flatMap((period) => period.dimensions)),
      },
      timeoutLogMessage: 'Qwen memory change aggregation request timed out',
    });
  }

  private async callQwenJsonCompletion({
    event,
    systemPrompt,
    userContent,
    logMetadata,
    timeoutLogMessage,
  }: QwenJsonCompletionInput): Promise<string> {
    const timeoutMs = this.config.analysis.qwenRequestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const requestStartedAt = Date.now();
    const requestBody = JSON.stringify({
      model: this.config.analysis.qwenModel,
      temperature: 0.1,
      enable_thinking: false,
      response_format: {
        type: 'json_object',
      },
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
    });

    try {
      const response = await fetch(`${this.config.analysis.qwenApiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.analysis.qwenApiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
      });
      const payload = await response.json().catch(() => null) as QwenChatCompletionPayload | null;
      const durationMs = Date.now() - requestStartedAt;
      this.logger.log(JSON.stringify({
        event,
        durationMs,
        httpStatus: response.status,
        model: payload?.model ?? this.config.analysis.qwenModel,
        ...logMetadata,
        systemPromptChars: systemPrompt.length,
        userPromptChars: userContent.length,
        requestBodyChars: requestBody.length,
        promptTokens: payload?.usage?.prompt_tokens ?? payload?.usage?.promptTokens ?? null,
        completionTokens: payload?.usage?.completion_tokens ?? payload?.usage?.completionTokens ?? null,
        totalTokens: payload?.usage?.total_tokens ?? payload?.usage?.totalTokens ?? null,
      }));

      if (!response.ok) {
        throw new AppError(payload?.error?.message ?? `Qwen request failed with status ${response.status}`, {
          statusCode: HttpStatus.BAD_GATEWAY,
          code: payload?.error?.code ?? 'QWEN_HTTP_ERROR',
          details: { httpStatus: response.status },
        });
      }

      const content = payload?.choices?.[0]?.message?.content;
      if (!content) {
        throw new AppError('Qwen response did not include message content', {
          statusCode: HttpStatus.BAD_GATEWAY,
          code: 'QWEN_EMPTY_RESPONSE',
        });
      }

      return content;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const timedOut = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(timedOut ? `${timeoutLogMessage} after ${timeoutMs}ms` : message);
      throw new AppError(timedOut ? `Qwen request timed out after ${timeoutMs}ms` : message, {
        statusCode: HttpStatus.BAD_GATEWAY,
        code: timedOut ? 'QWEN_REQUEST_TIMEOUT' : 'QWEN_REQUEST_FAILED',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseJsonObject(content: string): RawPeriodSummaryResult {
    try {
      return JSON.parse(content) as RawPeriodSummaryResult;
    } catch {
      const match = /\{[\s\S]*\}/.exec(content);
      if (match) {
        try {
          return JSON.parse(match[0]) as RawPeriodSummaryResult;
        } catch {
          // Fall through to the structured AppError below.
        }
      }
    }

    throw new AppError('Qwen response was not valid JSON', {
      statusCode: HttpStatus.BAD_GATEWAY,
      code: 'QWEN_JSON_PARSE_FAILED',
    });
  }

  private parseChangeAggregationJsonObject(content: string): RawChangeAggregationResult {
    try {
      return JSON.parse(content) as RawChangeAggregationResult;
    } catch {
      const match = /\{[\s\S]*\}/.exec(content);
      if (match) {
        try {
          return JSON.parse(match[0]) as RawChangeAggregationResult;
        } catch {
          // Fall through to the structured AppError below.
        }
      }
    }

    throw new AppError('Qwen response was not valid JSON', {
      statusCode: HttpStatus.BAD_GATEWAY,
      code: 'QWEN_JSON_PARSE_FAILED',
    });
  }

  private normalizeChangeAggregationResult(
    raw: RawChangeAggregationResult,
    periods: MemoryAnalysisPeriodSummary[],
  ): MemoryAnalysisChangeDimensionGroup[] {
    const rawDimensions = raw.dimensions ?? raw.d;
    if (!Array.isArray(rawDimensions)) {
      return [];
    }

    const sourceEvidence = this.buildSourceEvidenceMap(periods);

    return rawDimensions
      .map((item): MemoryAnalysisChangeDimensionGroup | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }
        const rawGroup = item as Record<string, unknown>;
        const dimension = this.normalizeDimension(rawGroup.dimension ?? rawGroup.dim ?? rawGroup.k);
        if (!dimension) {
          return null;
        }

        const changes = this.normalizeAggregatedChanges(rawGroup.changes ?? rawGroup.c, sourceEvidence);
        return changes.length > 0
          ? { dimension, changes }
          : null;
      })
      .filter((item): item is MemoryAnalysisChangeDimensionGroup => item !== null)
      .sort((left, right) => this.dimensionSortIndex(left.dimension) - this.dimensionSortIndex(right.dimension));
  }

  private normalizeAggregatedChanges(
    value: unknown,
    sourceEvidence: Map<string, MemoryAnalysisChangeEvidence>,
  ): MemoryAnalysisChange[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemoryAnalysisChange | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }

        const rawChange = item as Record<string, unknown>;
        const evidence = this.normalizeAggregatedEvidence(rawChange.evidence ?? rawChange.e, sourceEvidence);
        const title = this.normalizeTitle(rawChange.title ?? rawChange.t, evidence[0]?.quote ?? '');
        const summary = this.normalizeSummary(rawChange.summary ?? rawChange.s, title);
        const period = this.normalizeChangePeriod(rawChange.period ?? rawChange.p);
        if (title.length === 0 || !period || evidence.length === 0) {
          return null;
        }

        return {
          title,
          summary,
          period,
          evidence,
        };
      })
      .filter((item): item is MemoryAnalysisChange => item !== null)
      .sort((left, right) => (
        left.period.start.localeCompare(right.period.start)
        || left.period.end.localeCompare(right.period.end)
        || left.title.localeCompare(right.title)
      ));
  }

  private normalizeAggregatedEvidence(
    value: unknown,
    sourceEvidence: Map<string, MemoryAnalysisChangeEvidence>,
  ): MemoryAnalysisChangeEvidence[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const evidence: MemoryAnalysisChangeEvidence[] = [];
    const seenIds = new Set<string>();
    for (const item of value) {
      if (typeof item === 'string') {
        const evidenceId = this.normalizeText(item, '');
        if (seenIds.has(evidenceId)) {
          continue;
        }
        const sourceItem = sourceEvidence.get(evidenceId);
        if (!sourceItem) {
          continue;
        }
        seenIds.add(evidenceId);
        evidence.push(sourceItem);
        if (evidence.length >= MAX_EVIDENCE_PER_CHANGE) {
          break;
        }
        continue;
      }
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const rawEvidence = item as Record<string, unknown>;
      const evidenceId = this.normalizeText(rawEvidence.evidenceId ?? rawEvidence.id, '');
      if (seenIds.has(evidenceId)) {
        continue;
      }
      const sourceItem = sourceEvidence.get(evidenceId);
      if (!sourceItem) {
        continue;
      }
      seenIds.add(evidenceId);
      evidence.push(sourceItem);
      if (evidence.length >= MAX_EVIDENCE_PER_CHANGE) {
        break;
      }
    }

    return evidence;
  }

  private normalizeChangePeriod(value: unknown): { start: string; end: string } | null {
    if (value === null || typeof value !== 'object') {
      return null;
    }

    const rawPeriod = value as Record<string, unknown>;
    const start = this.normalizeText(rawPeriod.start ?? rawPeriod.s, '');
    const end = this.normalizeText(rawPeriod.end ?? rawPeriod.e, '');
    return start.length > 0 && end.length > 0
      ? { start, end }
      : null;
  }

  private toChangeAggregationPromptPeriods(periods: MemoryAnalysisPeriodSummary[]): unknown[] {
    return periods.map((period) => ({
      r: {
        s: period.period.start,
        e: period.period.end,
      },
      d: period.dimensions.map((group) => ({
        k: group.dimension,
        i: group.insights.map((insight) => ({
          t: insight.title,
          s: insight.summary,
          e: insight.evidence.map((evidence) => ({
            id: evidence.evidenceId,
            q: evidence.quote,
          })),
        })),
      })),
    }));
  }

  private buildSourceEvidenceMap(periods: MemoryAnalysisPeriodSummary[]): Map<string, MemoryAnalysisChangeEvidence> {
    const evidenceById = new Map<string, MemoryAnalysisChangeEvidence>();
    for (const period of periods) {
      for (const group of period.dimensions) {
        for (const insight of group.insights) {
          for (const evidence of insight.evidence) {
            evidenceById.set(evidence.evidenceId, {
              evidenceId: evidence.evidenceId,
              quote: evidence.quote,
              ...this.pickEvidenceReview(evidence),
            });
          }
        }
      }
    }
    return evidenceById;
  }

  private dimensionSortIndex(dimension: MemorySignalDimension): number {
    return [...MEMORY_ANALYSIS_DIMENSIONS].indexOf(dimension);
  }

  private normalizePeriodSummaryResult(
    raw: RawPeriodSummaryResult,
    promptPeriods: PromptPeriod[],
  ): MemoryAnalysisPeriodSummary[] {
    if (!Array.isArray(raw.periods)) {
      return promptPeriods.map((period) => this.emptyPeriodSummary(period));
    }

    const byPeriodKey = new Map<string, MemoryAnalysisPeriodDimensionGroup[]>();
    for (const item of raw.periods) {
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const rawPeriod = item as Record<string, unknown>;
      const periodKey = this.normalizeText(rawPeriod.periodKey, '');
      const promptPeriod = promptPeriods.find((period) => period.periodKey === periodKey);
      if (!promptPeriod) {
        continue;
      }

      byPeriodKey.set(
        periodKey,
        this.normalizeDimensionGroups(rawPeriod.dimensions, promptPeriod),
      );
    }

    return promptPeriods.map((period) => ({
      period: {
        start: period.start,
        end: period.end,
      },
      dimensions: byPeriodKey.get(period.periodKey) ?? [],
    }));
  }

  private normalizeCachedPeriodSummary(
    value: unknown,
    promptPeriod: PromptPeriod,
  ): MemoryAnalysisPeriodSummary {
    if (value === null || typeof value !== 'object') {
      return this.emptyPeriodSummary(promptPeriod);
    }

    const raw = value as Record<string, unknown>;

    return {
      period: {
        start: this.normalizeText((raw.period as Record<string, unknown> | undefined)?.start, promptPeriod.start),
        end: this.normalizeText((raw.period as Record<string, unknown> | undefined)?.end, promptPeriod.end),
      },
      dimensions: this.normalizeCachedDimensionGroups(raw.dimensions),
    };
  }

  private normalizeCachedDimensionGroups(value: unknown): MemoryAnalysisPeriodDimensionGroup[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemoryAnalysisPeriodDimensionGroup | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }
        const rawGroup = item as Record<string, unknown>;
        const dimension = this.normalizeDimension(rawGroup.dimension ?? rawGroup.dim);
        if (!dimension) {
          return null;
        }

        return {
          dimension,
          insights: this.normalizeCachedInsights(rawGroup.insights),
        };
      })
      .filter((item): item is MemoryAnalysisPeriodDimensionGroup => item !== null && item.insights.length > 0);
  }

  private normalizeCachedInsights(value: unknown): MemoryAnalysisPeriodInsight[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemoryAnalysisPeriodInsight | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }

        const rawInsight = item as Record<string, unknown>;
        const evidence = this.normalizeCachedEvidence(rawInsight.evidence);
        const summary = this.normalizeSummary(rawInsight.summary, evidence[0]?.quote ?? '');
        const title = this.normalizeTitle(rawInsight.title, summary);
        if (summary.length === 0) {
          return null;
        }

        return {
          title,
          summary,
          evidence,
        };
      })
      .filter((item): item is MemoryAnalysisPeriodInsight => item !== null && item.evidence.length > 0)
      .slice(0, MAX_INSIGHTS_PER_DIMENSION_PER_PERIOD);
  }

  private normalizeCachedEvidence(value: unknown): MemoryAnalysisPeriodInsightEvidence[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemoryAnalysisPeriodInsightEvidence | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }

        const rawEvidence = item as Record<string, unknown>;
        const evidenceId = this.normalizeText(rawEvidence.evidenceId, '');
        const quote = this.normalizeText(rawEvidence.quote, '').slice(0, 280);
        if (evidenceId.length === 0 || quote.length === 0) {
          return null;
        }

        return {
          evidenceId,
          quote,
          ...this.extractEvidenceReview(rawEvidence),
        };
      })
      .filter((item): item is MemoryAnalysisPeriodInsightEvidence => item !== null)
      .slice(0, MAX_EVIDENCE_PER_INSIGHT);
  }

  private emptyPeriodSummary(period: PromptPeriod): MemoryAnalysisPeriodSummary {
    return {
      period: {
        start: period.start,
        end: period.end,
      },
      dimensions: [],
    };
  }

  private normalizeDimensionGroups(
    value: unknown,
    period: PromptPeriod,
  ): MemoryAnalysisPeriodDimensionGroup[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemoryAnalysisPeriodDimensionGroup | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }
        const rawGroup = item as Record<string, unknown>;
        const dimension = this.normalizeDimension(rawGroup.dimension ?? rawGroup.dim);
        if (!dimension) {
          return null;
        }

        return {
          dimension,
          insights: this.normalizeInsights(rawGroup.insights, period),
        };
      })
      .filter((item): item is MemoryAnalysisPeriodDimensionGroup => item !== null && item.insights.length > 0);
  }

  private normalizeInsights(
    value: unknown,
    period: PromptPeriod,
  ): MemoryAnalysisPeriodInsight[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemoryAnalysisPeriodInsight | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }

        const rawInsight = item as Record<string, unknown>;
        const evidence = this.normalizeEvidence(rawInsight.evidence, period);
        const summary = this.normalizeSummary(rawInsight.summary, evidence[0]?.quote ?? '');
        const title = this.normalizeTitle(rawInsight.title, summary);
        if (summary.length === 0) {
          return null;
        }

        return {
          title,
          summary,
          evidence,
        };
      })
      .filter((item): item is MemoryAnalysisPeriodInsight => item !== null && item.evidence.length > 0)
      .slice(0, MAX_INSIGHTS_PER_DIMENSION_PER_PERIOD);
  }

  private normalizeEvidence(
    value: unknown,
    period: PromptPeriod,
  ): MemoryAnalysisPeriodInsightEvidence[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemoryAnalysisPeriodInsightEvidence | null => {
        if (typeof item === 'string') {
          const quote = this.normalizeText(item, '').slice(0, 280);
          const evidenceId = this.findEvidenceIdByQuote(quote, period);
          return quote.length > 0 && evidenceId
            ? {
              evidenceId,
              quote,
              ...this.evidenceReviewForId(evidenceId, period),
            }
            : null;
        }
        if (item === null || typeof item !== 'object') {
          return null;
        }
        const rawEvidence = item as Record<string, unknown>;
        const quote = this.normalizeText(rawEvidence.quote, '').slice(0, 280);
        if (quote.length === 0) {
          return null;
        }
        const evidenceId = this.normalizeEvidenceId(rawEvidence, quote, period);
        return evidenceId
          ? {
            evidenceId,
            quote,
            ...this.evidenceReviewForId(evidenceId, period),
          }
          : null;
      })
      .filter((item): item is MemoryAnalysisPeriodInsightEvidence => item !== null)
      .slice(0, MAX_EVIDENCE_PER_INSIGHT);
  }

  private normalizeEvidenceId(
    rawEvidence: Record<string, unknown>,
    quote: string,
    period: PromptPeriod,
  ): string | null {
    const rawId = this.normalizeText(
      rawEvidence.evidenceId ?? rawEvidence.id ?? rawEvidence.memoryId,
      '',
    );
    if (period.memories.some((memory) => memory.id === rawId)) {
      return rawId;
    }

    return this.findEvidenceIdByQuote(quote, period);
  }

  private findEvidenceIdByQuote(quote: string, period: PromptPeriod): string | null {
    if (quote.length === 0) {
      return null;
    }

    return period.memories.find((memory) => memory.text.includes(quote) || quote.includes(memory.text))?.id ?? null;
  }

  private evidenceReviewForId(
    evidenceId: string,
    period: PromptPeriod,
  ): Partial<MemoryAnalysisPeriodInsightEvidence> {
    const memory = period.memories.find((item) => item.id === evidenceId);
    return memory ? this.pickEvidenceReview(memory) : {};
  }

  private pickEvidenceReview(
    value: {
      review?: MemoryAnalysisPeriodInsightEvidence['review'];
    },
  ): Partial<MemoryAnalysisPeriodInsightEvidence> {
    return value.review ? { review: value.review } : {};
  }

  private extractEvidenceReview(value: Record<string, unknown>): Partial<MemoryAnalysisPeriodInsightEvidence> {
    const review = this.normalizeEvidenceReview(value.review);
    return review ? { review } : {};
  }

  private normalizeCorrectness(value: unknown): 'correct' | 'incorrect' | undefined {
    return value === 'correct' || value === 'incorrect' ? value : undefined;
  }

  private normalizeEvidenceReview(value: unknown): MemoryAnalysisPeriodInsightEvidence['review'] | undefined {
    if (value === null || typeof value !== 'object') {
      return undefined;
    }

    const rawReview = value as Record<string, unknown>;
    const correctness = this.normalizeCorrectness(rawReview.correctness);
    const edited = typeof rawReview.edited === 'boolean' ? rawReview.edited : undefined;
    const editVersion = typeof rawReview.editVersion === 'number' && Number.isFinite(rawReview.editVersion)
      ? rawReview.editVersion
      : undefined;
    const editedAt = this.normalizeText(rawReview.editedAt, '');
    const review = {
      ...(correctness ? { correctness } : {}),
      ...(edited !== undefined ? { edited } : {}),
      ...(editVersion !== undefined ? { editVersion } : {}),
      ...(editedAt ? { editedAt } : {}),
    };

    return Object.keys(review).length > 0 ? review : undefined;
  }

  private normalizeSummary(value: unknown, fallback: string): string {
    const summary = this.normalizeText(value, '').slice(0, 80);
    return summary.length > 0 ? summary : fallback.slice(0, 20);
  }

  private normalizeTitle(value: unknown, fallback: string): string {
    const title = this.normalizeText(value, '').replace(/[。.!！?？]+$/u, '').slice(0, 24);
    if (title.length > 0) {
      return title;
    }

    return fallback.replace(/[。.!！?？]+$/u, '').slice(0, 12);
  }

  private normalizeDimension(value: unknown): MemorySignalDimension | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    return MEMORY_ANALYSIS_DIMENSIONS.has(normalized as MemorySignalDimension)
      ? normalized as MemorySignalDimension
      : null;
  }

  private buildPromptPeriods(
    memories: DeepAnalysisMemorySnapshot[],
    dto: AnalyzeMemorySourceDto,
  ): PromptPeriod[] {
    const promptMemoriesByDay = new Map<string, PromptMemory[]>();
    let remainingContentChars = MAX_BATCH_CONTENT_CHARS;
    const requestedStart = new Date(dto.createdAfter);
    const requestedEnd = new Date(dto.createdBefore);
    const now = new Date();

    const sortedMemories = [...memories].sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? ''));
    for (const memory of sortedMemories) {
      if (remainingContentChars <= 0) {
        break;
      }

      if (memory.content.trim().length === 0) {
        continue;
      }

      const promptMemory = this.toPromptMemory(
        memory,
        Math.min(MAX_CONTENT_CHARS, remainingContentChars),
      );
      const dayKey = this.toDayKey(memory.createdAt);
      const group = promptMemoriesByDay.get(dayKey);
      if (group) {
        group.push(promptMemory);
      } else {
        promptMemoriesByDay.set(dayKey, [promptMemory]);
      }
      remainingContentChars -= promptMemory.text.length;
    }

    return [...promptMemoriesByDay.entries()].map(([dayKey, promptMemories]) => {
      const boundaries = this.buildPeriodBoundaries(dayKey, promptMemories);
      return {
        periodKey: dayKey,
        start: boundaries.start,
        end: boundaries.end,
        cacheable: this.isCacheablePromptPeriod(dayKey, boundaries, requestedStart, requestedEnd, now),
        memories: promptMemories,
      };
    });
  }

  private isCacheablePromptPeriod(
    dayKey: string,
    period: { start: string; end: string },
    requestedStart: Date,
    requestedEnd: Date,
    now: Date,
  ): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      return false;
    }

    const periodStart = new Date(period.start);
    const periodEnd = new Date(period.end);
    return (
      requestedStart.getTime() <= periodStart.getTime()
      && requestedEnd.getTime() >= periodEnd.getTime()
      && now.getTime() > periodEnd.getTime()
    );
  }

  private toPromptMemory(
    memory: DeepAnalysisMemorySnapshot,
    maxContentChars: number,
  ): PromptMemory {
    const trimmed = this.trimForSignalExtraction(memory.content, maxContentChars);
    return {
      id: memory.id,
      createdAt: memory.createdAt,
      text: trimmed.content,
      ...this.extractMemoryEvidenceReview(memory),
    };
  }

  private extractMemoryEvidenceReview(memory: DeepAnalysisMemorySnapshot): Partial<PromptMemory> {
    const metadata = memory.metadata;
    if (metadata === null || typeof metadata !== 'object') {
      return {};
    }

    const correctness = this.normalizeCorrectness(metadata.correctness);
    const edited = typeof metadata.edited === 'boolean' ? metadata.edited : undefined;
    const editVersion = typeof metadata.edit_version === 'number' && Number.isFinite(metadata.edit_version)
      ? metadata.edit_version
      : undefined;
    const editedAt = this.normalizeText(metadata.edited_at, '');

    const review = {
      ...(correctness ? { correctness } : {}),
      ...(edited !== undefined ? { edited } : {}),
      ...(editVersion !== undefined ? { editVersion } : {}),
      ...(editedAt ? { editedAt } : {}),
    };

    return Object.keys(review).length > 0 ? { review } : {};
  }

  private toDayKey(value?: string): string {
    if (!value) {
      return 'unknown-date';
    }

    const datePart = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : 'unknown-date';
  }

  private buildPeriodBoundaries(dayKey: string, memories: PromptMemory[]): { start: string; end: string } {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      return {
        start: `${dayKey}T00:00:00Z`,
        end: `${dayKey}T23:59:59Z`,
      };
    }

    const times = memories
      .map((memory) => memory.createdAt)
      .filter((value): value is string => value !== undefined && value.length > 0)
      .sort();

    return {
      start: times[0] ?? '',
      end: times[times.length - 1] ?? '',
    };
  }

  private countChanges(groups: MemoryAnalysisChangeDimensionGroup[]): number {
    return groups.reduce((count, group) => count + group.changes.length, 0);
  }

  private countPeriodInsights(groups: MemoryAnalysisPeriodDimensionGroup[]): number {
    return groups.reduce((count, group) => count + group.insights.length, 0);
  }

  private trimForSignalExtraction(
    content: string,
    maxContentChars: number,
  ): { content: string; truncated: boolean } {
    const normalized = content.trim();
    if (normalized.length <= maxContentChars) {
      return { content: normalized, truncated: false };
    }

    const headLength = Math.floor(maxContentChars * 0.6);
    const tailLength = maxContentChars - headLength;

    return {
      content: `${normalized.slice(0, headLength)}\n\n[...content truncated...]\n\n${normalized.slice(-tailLength)}`,
      truncated: true,
    };
  }

  private normalizeText(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value.trim().slice(0, 1000) : fallback;
  }

  private toReportResponse(report: MemoryReport): MemoryAnalysisReportResponse {
    return {
      report_id: report.reportId,
      template_id: report.templateId,
      report_content: report.reportContent,
      generated_at: report.generatedAt.toISOString(),
      render_status: report.renderStatus === 'fail' ? 'fail' : 'success',
      fail_reason: report.failReason,
      memory_count: report.memoryCount,
    };
  }
}
