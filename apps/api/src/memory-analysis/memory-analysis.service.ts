import { writeFile } from 'node:fs/promises';

import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';
import { AppError } from '@mem9/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import type { AnalyzeMemorySourceDto } from '../dto/analyze-memory-source.dto';
import { Mem9SourceService } from '../mem9-source.service';

import { MEMORY_PERIOD_SUMMARY_SYSTEM_PROMPT } from './prompts';
import type {
  AnalyzeMemorySourceChangesResponse,
  AnalyzeMemorySourcePeriodSummaryResponse,
  MemoryAnalysisDimensionGroup,
  MemoryAnalysisInsight,
  MemoryAnalysisInsightEvidence,
  MemoryAnalysisPeriodDimensionGroup,
  MemoryAnalysisPeriodInsight,
  MemoryAnalysisPeriodInsightEvidence,
  MemoryAnalysisPeriodSummary,
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

const MAX_CONTENT_CHARS = 12000;
const MAX_BATCH_CONTENT_CHARS = 60000;
const MAX_INSIGHTS_PER_DIMENSION_PER_PERIOD = 1;
const MAX_EVIDENCE_PER_INSIGHT = 1;
const QWEN_PERIOD_SUMMARY_CONCURRENCY = 3;
const DEBUG_FIRST_PASS_OUTPUT_PATH = '/Users/ericzhang/Downloads/memory-analysis-first-pass.json';

@Injectable()
export class MemoryAnalysisService {
  private readonly logger = new Logger(MemoryAnalysisService.name);

  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly source: Mem9SourceService,
  ) {}

  public async analyzeSource(
    apiKey: string,
    dto: AnalyzeMemorySourceDto,
  ): Promise<AnalyzeMemorySourceChangesResponse | AnalyzeMemorySourcePeriodSummaryResponse> {
    const startedAt = Date.now();
    const firstPass = await this.summarizeSourcePeriods(apiKey, dto);
    if (dto.debugFirstPass) {
      await writeFile(DEBUG_FIRST_PASS_OUTPUT_PATH, JSON.stringify(firstPass, null, 2));
      return firstPass;
    }

    const aggregationStartedAt = Date.now();
    const dimensions = this.buildChangeDimensions(firstPass.periods);
    const aggregationDurationMs = Date.now() - aggregationStartedAt;
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_completed',
      durationMs: Date.now() - startedAt,
      aggregationDurationMs,
      total: firstPass.total,
      periodCount: firstPass.periods.length,
      insightCount: this.countPeriodInsights(firstPass.periods.flatMap((period) => period.dimensions)),
      dimensionCount: dimensions.length,
    }));

    return {
      total: firstPass.total,
      limit: firstPass.limit,
      offset: firstPass.offset,
      model: firstPass.model,
      dimensions,
    };
  }

  private async summarizeSourcePeriods(
    apiKey: string,
    dto: AnalyzeMemorySourceDto,
  ): Promise<AnalyzeMemorySourcePeriodSummaryResponse> {
    const fetchStartedAt = Date.now();
    const page = await this.source.fetchMemories(apiKey, dto.limit, dto.offset);
    const fetchDurationMs = Date.now() - fetchStartedAt;
    const promptStartedAt = Date.now();
    const periods = this.buildPromptPeriods(page.memories);
    const promptDurationMs = Date.now() - promptStartedAt;
    const promptMemories = periods.flatMap((period) => period.memories);
    const promptContentChars = promptMemories.reduce((count, memory) => count + memory.text.length, 0);
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_source_prepared',
      fetchDurationMs,
      promptDurationMs,
      total: page.total,
      returnedMemories: page.memories.length,
      promptPeriods: periods.length,
      promptMemories: promptMemories.length,
      promptContentChars,
      maxPromptMemoryChars: Math.max(0, ...promptMemories.map((memory) => memory.text.length)),
    }));

    if (periods.length === 0) {
      return {
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        model: this.config.analysis.qwenModel ?? '',
        periods: [],
      };
    }

    this.ensureQwenConfigured();

    const qwenStartedAt = Date.now();
    const periodResults = await this.summarizePromptPeriods(periods, dto.lang ?? 'zh-CN');
    const normalizedPeriods = periodResults.flatMap((result) => result.periods);
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_periods_normalized',
      qwenDurationMs: Date.now() - qwenStartedAt,
      responseChars: periodResults.reduce((count, result) => count + result.responseChars, 0),
      periodCount: normalizedPeriods.length,
      insightCount: this.countPeriodInsights(normalizedPeriods.flatMap((period) => period.dimensions)),
    }));

    return {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      model: this.config.analysis.qwenModel!,
      periods: normalizedPeriods,
    };
  }

  private async summarizePromptPeriods(
    periods: PromptPeriod[],
    lang: string,
  ): Promise<{ periods: MemoryAnalysisPeriodSummary[]; responseChars: number }[]> {
    return this.mapWithConcurrency(
      periods,
      QWEN_PERIOD_SUMMARY_CONCURRENCY,
      async (period) => {
        const content = await this.callQwenForPeriodSummaries([period], lang);
        const parsed = this.parseJsonObject(content);
        return {
          periods: this.normalizePeriodSummaryResult(parsed, [period]),
          responseChars: content.length,
        };
      },
    );
  }

  private buildChangeDimensions(periods: MemoryAnalysisPeriodSummary[]): MemoryAnalysisDimensionGroup[] {
    const dimensionGroups = periods.flatMap((period) => (
      period.dimensions.map((group) => this.toFinalDimensionGroup(period, group))
    ));
    const byDimension = this.groupBy(dimensionGroups, (item) => item.dimension);

    return [...MEMORY_ANALYSIS_DIMENSIONS]
      .map((dimension) => this.buildDimensionGroup(dimension, byDimension.get(dimension) ?? []))
      .filter((group): group is MemoryAnalysisDimensionGroup => group !== null);
  }

  private toFinalDimensionGroup(
    period: MemoryAnalysisPeriodSummary,
    group: MemoryAnalysisPeriodDimensionGroup,
  ): MemoryAnalysisDimensionGroup {
    return {
      dimension: group.dimension,
      insights: group.insights.map((insight) => this.toFinalInsight(period, insight)),
    };
  }

  private toFinalInsight(
    period: MemoryAnalysisPeriodSummary,
    insight: MemoryAnalysisPeriodInsight,
  ): MemoryAnalysisInsight {
    return {
      summary: insight.summary,
      time: {
        firstSeenAt: period.period.start,
        lastSeenAt: period.period.end,
      },
      evidence: insight.evidence.map((item) => ({
        evidenceId: item.evidenceId,
        quote: item.quote,
      })),
    };
  }

  private buildDimensionGroup(
    dimension: MemorySignalDimension,
    groups: MemoryAnalysisDimensionGroup[],
  ): MemoryAnalysisDimensionGroup | null {
    if (groups.length === 0) {
      return null;
    }

    const insights = this.mergePeriodInsights(groups.flatMap((group) => group.insights));

    return {
      dimension,
      insights,
    };
  }

  private mergePeriodInsights(insights: MemoryAnalysisInsight[]): MemoryAnalysisInsight[] {
    const bySummary = this.groupBy(insights, (item) => item.summary);

    return [...bySummary.values()]
      .map((items) => this.mergeInsightGroup(items))
      .sort((left, right) => (right.time.lastSeenAt ?? '').localeCompare(left.time.lastSeenAt ?? ''));
  }

  private mergeInsightGroup(insights: MemoryAnalysisInsight[]): MemoryAnalysisInsight {
    const sorted = [...insights].sort((left, right) => (left.time.firstSeenAt ?? '').localeCompare(right.time.firstSeenAt ?? ''));
    const firstSeenAt = sorted.find((item) => item.time.firstSeenAt)?.time.firstSeenAt;
    const lastSeenAt = [...sorted].reverse().find((item) => item.time.lastSeenAt)?.time.lastSeenAt;

    return {
      summary: sorted[0]?.summary ?? '',
      time: {
        firstSeenAt,
        lastSeenAt,
      },
      evidence: this.pickInsightEvidence(sorted.flatMap((item) => item.evidence)),
    };
  }

  private pickInsightEvidence(evidence: MemoryAnalysisInsightEvidence[]): MemoryAnalysisInsightEvidence[] {
    const uniqueEvidence: MemoryAnalysisInsightEvidence[] = [];
    const seenQuotes = new Set<string>();

    for (const item of evidence) {
      const quote = item.quote;
      if (seenQuotes.has(quote)) {
        continue;
      }
      seenQuotes.add(quote);
      uniqueEvidence.push({
        evidenceId: item.evidenceId,
        time: item.time,
        quote,
      });
    }

    if (uniqueEvidence.length <= MAX_EVIDENCE_PER_INSIGHT) {
      return uniqueEvidence;
    }

    const first = uniqueEvidence[0];
    const middle = uniqueEvidence[Math.floor(uniqueEvidence.length / 2)];
    const last = uniqueEvidence[uniqueEvidence.length - 1];
    const samples = [first, middle, last].filter((item): item is MemoryAnalysisInsightEvidence => item !== undefined);

    return samples.filter((item, index, items) => (
      items.findIndex((candidate) => (
        candidate.quote === item.quote
        && candidate.time === item.time
        && candidate.evidenceId === item.evidenceId
      )) === index
    ));
  }

  private groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const key = keyOf(item);
      const group = groups.get(key);
      if (group) {
        group.push(item);
      } else {
        groups.set(key, [item]);
      }
    }
    return groups;
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
    lang: string,
  ): Promise<string> {
    const timeoutMs = this.config.analysis.qwenRequestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const requestStartedAt = Date.now();
    const userContent = JSON.stringify({
      lang,
      periods,
    });
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
          content: MEMORY_PERIOD_SUMMARY_SYSTEM_PROMPT,
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
        event: 'memory_analysis_qwen_completed',
        durationMs,
        httpStatus: response.status,
        model: payload?.model ?? this.config.analysis.qwenModel,
        periodCount: periods.length,
        memoryCount: periods.reduce((count, period) => count + period.memories.length, 0),
        systemPromptChars: MEMORY_PERIOD_SUMMARY_SYSTEM_PROMPT.length,
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
      this.logger.warn(timedOut ? `Qwen memory period summary request timed out after ${timeoutMs}ms` : message);
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
        if (summary.length === 0) {
          return null;
        }

        return {
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
          return quote.length > 0 && evidenceId ? { evidenceId, quote } : null;
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
        return evidenceId ? { evidenceId, quote } : null;
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

  private normalizeSummary(value: unknown, fallback: string): string {
    const summary = this.normalizeText(value, '').slice(0, 40);
    return summary.length > 0 ? summary : fallback.slice(0, 20);
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

  private buildPromptPeriods(memories: DeepAnalysisMemorySnapshot[]): PromptPeriod[] {
    const promptMemoriesByDay = new Map<string, PromptMemory[]>();
    let remainingContentChars = MAX_BATCH_CONTENT_CHARS;

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
        memories: promptMemories,
      };
    });
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
    };
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

  private countInsights(groups: MemoryAnalysisDimensionGroup[]): number {
    return groups.reduce((count, group) => count + group.insights.length, 0);
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
