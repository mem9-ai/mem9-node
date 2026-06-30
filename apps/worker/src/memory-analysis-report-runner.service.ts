import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';
import { AnalysisRepository, AppError, sha256Hex } from '@mem9/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { Mem9SourceService } from './mem9-source.service';

import {
  MEMORY_PERIOD_SUMMARY_CACHE_VERSION,
  MEMORY_CHANGE_AGGREGATION_SYSTEM_PROMPT,
  MEMORY_PERIOD_SUMMARY_PROMPT_VERSION,
  MEMORY_PERIOD_SUMMARY_SYSTEM_PROMPT,
} from './memory-analysis/prompts';
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
  MemorySignalDimension,
  PromptMemory,
  PromptPeriod,
} from './memory-analysis/types';
import { MEMORY_ANALYSIS_DIMENSIONS } from './memory-analysis/types';

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
  logMetadata: Record<string, number | string | boolean | null | undefined>;
  timeoutLogMessage: string;
}

interface MemoryAnalysisReportLogMeta {
  reportId?: number;
}

export interface Mem9RequestContext {
  apiKeyFingerprint: Buffer;
  apiKeyFingerprintHex?: string;
  rawApiKey: string;
  requestId: string;
}

export interface AnalyzeMemorySourceInput {
  createdAfter: string;
  createdBefore: string;
}

const MAX_CONTENT_CHARS = 12000;
const MAX_BATCH_CONTENT_CHARS = 60000;
const MAX_INSIGHTS_PER_DIMENSION_PER_PERIOD = 3;
const MAX_EVIDENCE_PER_INSIGHT = 1;
const MAX_EVIDENCE_PER_CHANGE = 3;
const QWEN_PERIOD_SUMMARY_CONCURRENCY = 5;
const MAX_ANALYSIS_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const MEMORY_ANALYSIS_REPORT_MAX_ATTEMPTS = 3;
const MEMORY_ANALYSIS_REPORT_RETRY_BASE_MS = 1000;
const MEMORY_PERIOD_SUMMARY_PROMPT_HASH = sha256Hex(MEMORY_PERIOD_SUMMARY_SYSTEM_PROMPT);

@Injectable()
export class MemoryAnalysisReportRunnerService {
  private readonly logger = new Logger(MemoryAnalysisReportRunnerService.name);

  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly source: Mem9SourceService,
    private readonly repository: AnalysisRepository,
  ) {}

  public async analyzeSource(
    context: Mem9RequestContext,
    dto: AnalyzeMemorySourceInput,
    logMeta: MemoryAnalysisReportLogMeta = {},
  ): Promise<AnalyzeMemorySourceChangesResponse> {
    const startedAt = Date.now();
    this.validateDateRange(dto);
    const firstPass = await this.summarizeSourcePeriods(context, dto, logMeta);

    const aggregationStartedAt = Date.now();
    const dimensions = await this.aggregateChangeDimensions(firstPass.periods, logMeta);
    const aggregationDurationMs = Date.now() - aggregationStartedAt;
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_completed',
      ...logMeta,
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

  public async generateReport(
    context: Mem9RequestContext,
    reportId: number,
    dto: AnalyzeMemorySourceInput,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.repository.updateMemoryAnalysisReport(reportId, {
        renderStatus: 'running',
        reportStage: 'fetch_source',
        startedAt: new Date(),
        failCode: null,
        failReason: null,
      });
      this.logReportEvent('memory_analysis_report_started', {
        reportId,
        stage: 'fetch_source',
        attempt: 1,
        apiKeyFingerprint: context.apiKeyFingerprintHex ?? null,
      });

      const result = await this.generateReportWithRetry(context, reportId, dto);

      await this.repository.updateMemoryAnalysisReport(reportId, {
        renderStatus: 'running',
        reportStage: 'save_result',
        memoryCount: result.memoryCount,
      });
      this.logReportEvent('memory_analysis_report_stage_changed', {
        reportId,
        stage: 'save_result',
        memoryCount: result.memoryCount,
      });

      await this.repository.updateMemoryAnalysisReport(reportId, {
        reportContent: JSON.stringify(result),
        renderStatus: 'success',
        reportStage: 'complete',
        completedAt: new Date(),
        failCode: null,
        failReason: null,
        memoryCount: result.memoryCount,
      });
      this.logReportEvent('memory_analysis_report_completed', {
        reportId,
        stage: 'complete',
        durationMs: Date.now() - startedAt,
        memoryCount: result.memoryCount,
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      const failCode = appError?.code ?? 'MEMORY_ANALYSIS_GENERATION_FAILED';
      const failReason = this.getReportFailReason(error);

      this.logReportEvent('memory_analysis_report_failed', {
        reportId,
        stage: 'failed',
        durationMs: Date.now() - startedAt,
        failCode,
        failReason,
      }, 'error', error);

      await this.repository.updateMemoryAnalysisReport(reportId, {
        renderStatus: 'fail',
        reportStage: 'failed',
        completedAt: new Date(),
        failCode,
        failReason,
      });
    }
  }

  private async generateReportWithRetry(
    context: Mem9RequestContext,
    reportId: number,
    dto: AnalyzeMemorySourceInput,
  ): Promise<AnalyzeMemorySourceChangesResponse> {
    let attempt = 1;
    let lastError: unknown;

    while (attempt <= MEMORY_ANALYSIS_REPORT_MAX_ATTEMPTS) {
      try {
        this.logReportEvent('memory_analysis_report_attempt_started', {
          reportId,
          stage: 'fetch_source',
          attempt,
        });
        return await this.analyzeSource(context, dto, { reportId });
      } catch (error) {
        lastError = error;
        const appError = error instanceof AppError ? error : null;
        const retryable = this.isRetryableReportError(error);
        const willRetry = retryable && attempt < MEMORY_ANALYSIS_REPORT_MAX_ATTEMPTS;

        this.logReportEvent('memory_analysis_report_attempt_failed', {
          reportId,
          stage: 'failed',
          attempt,
          willRetry: willRetry ? 'true' : 'false',
          failCode: appError?.code ?? 'MEMORY_ANALYSIS_GENERATION_FAILED',
          failReason: this.getReportFailReason(error),
        }, willRetry ? 'warn' : 'error', error);

        if (!willRetry) {
          break;
        }

        await this.sleep(MEMORY_ANALYSIS_REPORT_RETRY_BASE_MS * attempt);
        attempt += 1;
      }
    }

    throw lastError;
  }

  private isRetryableReportError(error: unknown): boolean {
    if (!(error instanceof AppError)) {
      return true;
    }

    if (
      error.code === 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED'
      || error.code === 'QWEN_REQUEST_FAILED'
      || error.code === 'QWEN_REQUEST_TIMEOUT'
      || error.code === 'QWEN_EMPTY_RESPONSE'
    ) {
      return true;
    }

    if (error.code === 'QWEN_HTTP_ERROR') {
      const httpStatus = Number(error.details?.httpStatus);
      return httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
    }

    return false;
  }

  private getReportFailReason(error: unknown): string {
    if (!(error instanceof AppError)) {
      return 'Memory analysis failed because of an unexpected server error. Please retry later.';
    }

    if (error.code === 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED') {
      return 'Memory source API is unavailable or timed out. Please retry later.';
    }

    if (error.code === 'QWEN_REQUEST_TIMEOUT') {
      return 'Qwen request timed out. Please retry later.';
    }

    if (error.code === 'QWEN_REQUEST_FAILED') {
      return 'Qwen service is unavailable. Please retry later.';
    }

    if (error.code === 'QWEN_HTTP_ERROR') {
      const httpStatus = Number(error.details?.httpStatus);
      if (httpStatus === 401 || httpStatus === 403) {
        return 'Qwen authentication failed. Please check the configured API key.';
      }
      if (httpStatus === 429) {
        return 'Qwen rate limit was reached. Please retry later.';
      }
      if (httpStatus >= 500) {
        return 'Qwen service returned a server error. Please retry later.';
      }
      return `Qwen request was rejected with HTTP ${Number.isFinite(httpStatus) ? httpStatus : 'error'}.`;
    }

    if (error.code === 'QWEN_NOT_CONFIGURED') {
      return 'Qwen API key or model is not configured.';
    }

    if (error.code === 'QWEN_EMPTY_RESPONSE' || error.code === 'QWEN_JSON_PARSE_FAILED') {
      return 'Qwen returned an invalid response. Please retry later.';
    }

    return 'Memory analysis generation failed. Please retry later.';
  }

  private logReportEvent(
    event: string,
    data: Record<string, number | string | boolean | null | undefined>,
    level: 'log' | 'warn' | 'error' = 'log',
    error?: unknown,
  ): void {
    const payload = JSON.stringify({ event, ...data });
    if (level === 'error') {
      this.logger.error(payload, error instanceof Error ? error.stack : undefined);
      return;
    }
    if (level === 'warn') {
      this.logger.warn(payload);
      return;
    }
    this.logger.log(payload);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async summarizeSourcePeriods(
    context: Mem9RequestContext,
    dto: AnalyzeMemorySourceInput,
    logMeta: MemoryAnalysisReportLogMeta = {},
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
      ...logMeta,
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
    const periodResults = await this.summarizePromptPeriods(context.apiKeyFingerprint, periods, logMeta);
    const normalizedPeriods = periodResults.flatMap((result) => result.periods);
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_periods_normalized',
      ...logMeta,
      qwenDurationMs: Date.now() - qwenStartedAt,
      responseChars: periodResults.reduce((count, result) => count + result.responseChars, 0),
      cacheHits: periodResults.filter((result) => result.cacheHit).length,
      cacheMisses: periodResults.filter((result) => !result.cacheHit).length,
      cacheVersion: MEMORY_PERIOD_SUMMARY_CACHE_VERSION,
      promptVersion: MEMORY_PERIOD_SUMMARY_PROMPT_VERSION,
      promptHash: MEMORY_PERIOD_SUMMARY_PROMPT_HASH,
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

  private async summarizePromptPeriods(
    apiKeyFingerprint: Buffer,
    periods: PromptPeriod[],
    logMeta: MemoryAnalysisReportLogMeta = {},
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
            promptVersion: MEMORY_PERIOD_SUMMARY_CACHE_VERSION,
          })
          : null;

        if (cached) {
          return {
            periods: [this.normalizeCachedPeriodSummary(cached.resultJson, period)],
            responseChars: 0,
            cacheHit: true,
          };
        }

        const content = await this.callQwenForPeriodSummaries([period], logMeta);
        const parsed = this.parseJsonObject(content);
        const normalizedPeriods = this.normalizePeriodSummaryResult(parsed, [period]);
        if (period.cacheable) {
          await this.repository.upsertMemoryAnalysisPeriodCache({
            fingerprint: apiKeyFingerprint,
            periodKey: period.periodKey,
            model,
            promptVersion: MEMORY_PERIOD_SUMMARY_CACHE_VERSION,
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
    logMeta: MemoryAnalysisReportLogMeta = {},
  ): Promise<MemoryAnalysisChangeDimensionGroup[]> {
    if (periods.length === 0) {
      return [];
    }

    const content = await this.callQwenForChangeAggregation(periods, logMeta);
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
          ? { dimension, summary: this.summarizeDimensionChanges(changes), changes }
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

  private validateDateRange(dto: AnalyzeMemorySourceInput): void {
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
    logMeta: MemoryAnalysisReportLogMeta = {},
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
        ...logMeta,
        periodCount: periods.length,
        memoryCount: periods.reduce((count, period) => count + period.memories.length, 0),
        cacheVersion: MEMORY_PERIOD_SUMMARY_CACHE_VERSION,
        promptVersion: MEMORY_PERIOD_SUMMARY_PROMPT_VERSION,
        promptHash: MEMORY_PERIOD_SUMMARY_PROMPT_HASH,
      },
      timeoutLogMessage: 'Qwen memory period summary request timed out',
    });
  }

  private async callQwenForChangeAggregation(
    periods: MemoryAnalysisPeriodSummary[],
    logMeta: MemoryAnalysisReportLogMeta = {},
  ): Promise<string> {
    const userContent = JSON.stringify({
      p: this.toChangeAggregationPromptPeriods(periods),
    });

    return this.callQwenJsonCompletion({
      event: 'memory_analysis_change_aggregation_qwen_completed',
      systemPrompt: MEMORY_CHANGE_AGGREGATION_SYSTEM_PROMPT,
      userContent,
      logMetadata: {
        ...logMeta,
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

        const changes = this.normalizeAggregatedChanges(rawGroup.changes ?? rawGroup.c, sourceEvidence, dimension);
        const summary = this.normalizeSummary(rawGroup.summary ?? rawGroup.s, this.summarizeDimensionChanges(changes));
        return changes.length > 0
          ? {
            dimension,
            summary,
            changes,
          }
          : null;
      })
      .filter((item): item is MemoryAnalysisChangeDimensionGroup => item !== null)
      .sort((left, right) => this.dimensionSortIndex(left.dimension) - this.dimensionSortIndex(right.dimension));
  }

  private normalizeAggregatedChanges(
    value: unknown,
    sourceEvidence: Map<string, MemoryAnalysisChangeEvidence>,
    dimension: MemorySignalDimension,
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
        const score = dimension === 'emotion' ? this.normalizeEmotionScore(rawChange.score) : undefined;
        if (title.length === 0 || !period || evidence.length === 0) {
          return null;
        }

        return {
          title,
          summary,
          ...(score !== undefined ? { score } : {}),
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

  private summarizeDimensionChanges(changes: MemoryAnalysisChange[]): string {
    const summaries = changes
      .map((change) => change.summary)
      .filter((summary) => summary.length > 0);
    if (summaries.length === 0) {
      return '';
    }

    return summaries.slice(0, 2).join('；').slice(0, 120);
  }

  private normalizeEmotionScore(value: unknown): number | undefined {
    const score = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : NaN;
    if (!Number.isFinite(score)) {
      return undefined;
    }

    return Math.min(10, Math.max(1, Math.round(score)));
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
    dto: AnalyzeMemorySourceInput,
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

}
