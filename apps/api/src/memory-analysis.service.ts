import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';
import { AnalysisRepository, AppError } from '@mem9/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import type { AnalyzeMemorySourceDto } from './dto/analyze-memory-source.dto';
import type { CreateMemoryAnalysisReportDto } from './dto/create-memory-analysis-report.dto';
import type { ListMemoryAnalysisReportsDto } from './dto/list-memory-analysis-reports.dto';
import { Mem9SourceService } from './mem9-source.service';

export type MemorySignalDimension =
  | 'long_term_goal'
  | 'focus_area'
  | 'emotion'
  | 'preference_signal'
  | 'growth_signal';

export interface MemorySignalCandidate {
  evidenceId: string;
  dimension: MemorySignalDimension;
  summary: string;
  evidenceQuote: string;
}

export interface MemorySignalItem {
  memoryId: string;
  createdAt?: string;
  candidates: MemorySignalCandidate[];
}

export interface AnalyzeMemorySourceResponse {
  total: number;
  limit: number;
  offset: number;
  model: string;
  items: MemorySignalItem[];
}

export interface MemoryAnalysisEvidence {
  evidenceId: string;
  memoryId: string;
  createdAt?: string;
  dimension: MemorySignalDimension;
  summary: string;
  quote: string;
}

export interface MemoryAnalysisTimelinePoint {
  at?: string;
  evidenceIds: string[];
  evidenceMemoryIds: string[];
}

export interface MemoryAnalysisChangeDetail {
  timeline: MemoryAnalysisTimelinePoint[];
  evidence: MemoryAnalysisEvidence[];
}

export interface MemoryAnalysisDimensionGroup {
  dimension: MemorySignalDimension;
  confidence: number;
  relatedMemoryCount: number;
  detail: MemoryAnalysisChangeDetail;
}

export interface AnalyzeMemorySourceChangesResponse extends AnalyzeMemorySourceResponse {
  dimensions: MemoryAnalysisDimensionGroup[];
}

export interface MemoryAnalysisReportResponse {
  report_id: number;
  template_id: string;
  report_content: string;
  generated_at: string;
  render_status: 'fail' | 'success';
  fail_reason: string;
}

export interface ListMemoryAnalysisReportsResponse {
  reports: MemoryAnalysisReportResponse[];
}

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

interface RawMemorySignalResult {
  items?: unknown;
}

interface PromptMemory {
  id: string;
  text: string;
}

interface SignalObservation {
  dimension: MemorySignalDimension;
  evidence: MemoryAnalysisEvidence;
}

function toReportResponse(report: {
  reportId: number;
  templateId: string;
  reportContent: string;
  generatedAt: Date;
  renderStatus: string;
  failReason: string;
}): MemoryAnalysisReportResponse {
  return {
    report_id: report.reportId,
    template_id: report.templateId,
    report_content: report.reportContent,
    generated_at: report.generatedAt.toISOString(),
    render_status: report.renderStatus === 'fail' ? 'fail' : 'success',
    fail_reason: report.failReason,
  };
}

const MAX_CONTENT_CHARS = 12000;
const MAX_BATCH_CONTENT_CHARS = 60000;
const MAX_CANDIDATES_PER_MEMORY = 5;

const DIMENSIONS = new Set<MemorySignalDimension>([
  'long_term_goal',
  'focus_area',
  'emotion',
  'preference_signal',
  'growth_signal',
]);

const MEMORY_SIGNAL_SYSTEM_PROMPT = [
  'You are a high-recall memory signal extractor.',
  '',
  'Task: read the input memories and extract evidence-backed candidate signals for exactly five dimensions: long_term_goal, focus_area, emotion, preference_signal, growth_signal.',
  '',
  'Core rules:',
  '- This is the first-pass extraction step only. Do not infer trends, judge personality, or produce final analysis.',
  '- Prefer recall over precision. If a memory has direct evidence for any dimension, keep a candidate.',
  '- Judge each dimension independently. Do not infer one dimension from another.',
  '- Output a candidate only when it is directly supported by the input text.',
  '- If there is no direct evidence, return an empty candidates array for that memory.',
  '- Return at most one candidate per dimension per memory.',
  '- Every candidate must include only dim and summary.',
  '- dim must be one of: long_term_goal, focus_area, emotion, preference_signal, growth_signal.',
  '- summary must be a concise display phrase, 3-10 Chinese characters when the memory is Chinese, or 2-6 English words when the memory is English.',
  '- summary must describe the signal itself, not the dimension name.',
  '- Do not make medical diagnoses.',
  '- Return JSON only. No markdown.',
  '',
  'Dimension definitions:',
  '',
  'long_term_goal: long-term goals, exam preparation, career planning, health goals, habit building, or sustained plans. The evidence must imply future orientation, continuity, or a longer time horizon.',
  'Do not classify one-off tasks, current work items, or temporary wishes as long_term_goal.',
  '',
  'focus_area: current or recent attention, topics, projects, problems being worked on, repeated concerns, short-term interests, purchase intent, entertainment plans, and things the user wants to go to, buy, try, or arrange. Short-term signals are allowed.',
  '',
  'emotion: emotions or mental states expressed by the user themself. Do not treat another person or object’s emotion as the user’s emotion. Distinguish past from present, and allow mixed emotions.',
  '',
  'preference_signal: direct evidence of what the user prefers, likes, dislikes, avoids, values, or wants in communication, work style, tools, products, entertainment, learning, or life. This is only a candidate signal, not a final stable preference.',
  '',
  'growth_signal: direct evidence of learning, improvement, increased capability, reflection, changed behavior, overcoming difficulty, or becoming better at something. This is only a candidate signal, not a final growth conclusion.',
  '',
  'Chinese boundary examples:',
  '- “准备英语六级 / 法律职业资格考试 / 律师资格证” can be long_term_goal when it implies a sustained plan.',
  '- “想买高达手办 / 高达模型有点心动” is focus_area when it shows short-term interest or purchase intent.',
  '- “想去看五月天演唱会” is focus_area when it shows an entertainment plan or short-term interest.',
  '- “我更喜欢直接给结论，不要太啰嗦” is preference_signal.',
  '- “以后我还是想用更简洁的方式沟通需求” is preference_signal.',
  '- “这次虽然踩坑很多，但终于自己调通了” is growth_signal.',
  '- “我开始能主动判断架构问题，而不是只等别人告诉我” is growth_signal.',
  '- “健康习惯先保持基础步数” is usually focus_area, not long_term_goal, unless it implies a sustained goal.',
  '- “希望先把某功能跑通” is usually focus_area, not long_term_goal.',
  '- “我很焦虑 / 压力很大 / 真的好累” is emotion.',
  '',
  'Output JSON schema:',
  '{"items":[{"id":"memory id","candidates":[{"dim":"long_term_goal | focus_area | emotion | preference_signal | growth_signal","summary":"string"}]}]}',
].join('\n');

@Injectable()
export class MemoryAnalysisService {
  private readonly logger = new Logger(MemoryAnalysisService.name);

  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly source: Mem9SourceService,
    private readonly repository: AnalysisRepository,
  ) {}

  public async analyzeSource(
    apiKey: string,
    dto: AnalyzeMemorySourceDto,
  ): Promise<AnalyzeMemorySourceChangesResponse> {
    const startedAt = Date.now();
    const firstPass = await this.extractSourceCandidates(apiKey, dto);
    const aggregationStartedAt = Date.now();
    const dimensions = this.buildChangeDimensions(firstPass.items);
    const aggregationDurationMs = Date.now() - aggregationStartedAt;
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_completed',
      durationMs: Date.now() - startedAt,
      aggregationDurationMs,
      total: firstPass.total,
      returnedItems: firstPass.items.length,
      candidateCount: firstPass.items.reduce((count, item) => count + item.candidates.length, 0),
      dimensionCount: dimensions.length,
    }));

    return {
      ...firstPass,
      dimensions,
    };
  }

  public async createReport(
    dto: CreateMemoryAnalysisReportDto,
  ): Promise<MemoryAnalysisReportResponse> {
    const report = await this.repository.createReport({
      templateId: dto.template_id,
      reportContent: dto.report_content,
      renderStatus: dto.render_status,
      failReason: dto.fail_reason ?? '',
    });

    return toReportResponse(report);
  }

  public async getReport(reportId: string): Promise<MemoryAnalysisReportResponse | null> {
    const numericReportId = Number(reportId);

    if (!Number.isInteger(numericReportId) || numericReportId <= 0) {
      return null;
    }

    const report = await this.repository.findReport(numericReportId);

    return report ? toReportResponse(report) : null;
  }

  public async listReports(
    query: ListMemoryAnalysisReportsDto,
  ): Promise<ListMemoryAnalysisReportsResponse> {
    const reports = await this.repository.listReportsByTemplateId(query.type);

    return {
      reports: reports.map((report) => toReportResponse(report)),
    };
  }

  private async extractSourceCandidates(
    apiKey: string,
    dto: AnalyzeMemorySourceDto,
  ): Promise<AnalyzeMemorySourceResponse> {
    const fetchStartedAt = Date.now();
    const page = await this.source.fetchMemories(apiKey, dto.limit, dto.offset);
    const fetchDurationMs = Date.now() - fetchStartedAt;
    const allMemoryIds = page.memories.map((memory) => memory.id);
    const createdAtByMemoryId = new Map(page.memories.map((memory) => [memory.id, memory.createdAt]));
    const promptStartedAt = Date.now();
    const memories = this.buildPromptMemories(page.memories);
    const promptDurationMs = Date.now() - promptStartedAt;
    const promptContentChars = memories.reduce((count, memory) => count + memory.text.length, 0);
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_source_prepared',
      fetchDurationMs,
      promptDurationMs,
      total: page.total,
      returnedMemories: page.memories.length,
      promptMemories: memories.length,
      promptContentChars,
      maxPromptMemoryChars: Math.max(0, ...memories.map((memory) => memory.text.length)),
    }));

    if (memories.length === 0) {
      return {
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        model: this.config.analysis.qwenModel ?? '',
        items: allMemoryIds.map((memoryId) => ({
          memoryId,
          createdAt: createdAtByMemoryId.get(memoryId),
          candidates: [],
        })),
      };
    }

    this.ensureQwenConfigured();

    const qwenStartedAt = Date.now();
    const content = await this.callQwenForCandidates(memories, dto.lang ?? 'zh-CN');
    const qwenDurationMs = Date.now() - qwenStartedAt;
    const normalizeStartedAt = Date.now();
    const parsed = this.parseJsonObject(content);
    const items = this.normalizeSignalResult(
      parsed,
      new Set(allMemoryIds),
      new Map(memories.map((memory) => [memory.id, memory.text])),
      createdAtByMemoryId,
    );
    this.logger.log(JSON.stringify({
      event: 'memory_analysis_candidates_normalized',
      qwenDurationMs,
      normalizeDurationMs: Date.now() - normalizeStartedAt,
      responseChars: content.length,
      candidateCount: items.reduce((count, item) => count + item.candidates.length, 0),
    }));

    return {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      model: this.config.analysis.qwenModel!,
      items,
    };
  }

  private buildChangeDimensions(items: MemorySignalItem[]): MemoryAnalysisDimensionGroup[] {
    const observations = this.buildSignalObservations(items);
    const byDimension = this.groupBy(observations, (item) => item.dimension);

    return [...DIMENSIONS]
      .map((dimension) => this.buildDimensionGroup(dimension, byDimension.get(dimension) ?? []))
      .filter((group): group is MemoryAnalysisDimensionGroup => group !== null);
  }

  private buildSignalObservations(items: MemorySignalItem[]): SignalObservation[] {
    const observations: SignalObservation[] = [];

    for (const item of items) {
      for (const candidate of item.candidates) {
        observations.push({
          dimension: candidate.dimension,
          evidence: {
            evidenceId: candidate.evidenceId,
            memoryId: item.memoryId,
            createdAt: item.createdAt,
            dimension: candidate.dimension,
            summary: candidate.summary,
            quote: candidate.evidenceQuote,
          },
        });
      }
    }

    return observations.sort((left, right) => (left.evidence.createdAt ?? '').localeCompare(right.evidence.createdAt ?? ''));
  }

  private buildDimensionGroup(
    dimension: MemorySignalDimension,
    observations: SignalObservation[],
  ): MemoryAnalysisDimensionGroup | null {
    if (observations.length === 0) {
      return null;
    }

    const sorted = [...observations].sort((left, right) => (left.evidence.createdAt ?? '').localeCompare(right.evidence.createdAt ?? ''));
    const memoryIds = this.unique(sorted.map((item) => item.evidence.memoryId));
    const dayCount = this.unique(sorted.map((item) => (item.evidence.createdAt ?? '').slice(0, 10)).filter((value) => value.length > 0)).length;

    return {
      dimension,
      confidence: this.calculateDimensionConfidence(memoryIds.length, dayCount),
      relatedMemoryCount: memoryIds.length,
      detail: {
        timeline: this.buildTimeline(sorted),
        evidence: sorted.map((item) => item.evidence),
      },
    };
  }

  private buildTimeline(observations: SignalObservation[]): MemoryAnalysisTimelinePoint[] {
    return observations.map((item) => ({
      at: item.evidence.createdAt,
      evidenceIds: [item.evidence.evidenceId],
      evidenceMemoryIds: [item.evidence.memoryId],
    }));
  }

  private unique<T>(values: T[]): T[] {
    return [...new Set(values)];
  }

  private calculateDimensionConfidence(memoryCount: number, dayCount: number): number {
    return this.roundConfidence(Math.min(0.95, 0.45 + memoryCount * 0.1 + dayCount * 0.08));
  }

  private roundConfidence(value: number): number {
    return Math.round(value * 100) / 100;
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

  private async callQwenForCandidates(
    memories: PromptMemory[],
    lang: string,
  ): Promise<string> {
    const timeoutMs = this.config.analysis.qwenRequestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const requestStartedAt = Date.now();
    const userContent = JSON.stringify({
      lang,
      memories,
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
          content: MEMORY_SIGNAL_SYSTEM_PROMPT,
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
        memoryCount: memories.length,
        systemPromptChars: MEMORY_SIGNAL_SYSTEM_PROMPT.length,
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
      this.logger.warn(timedOut ? `Qwen memory signal request timed out after ${timeoutMs}ms` : message);
      throw new AppError(timedOut ? `Qwen request timed out after ${timeoutMs}ms` : message, {
        statusCode: HttpStatus.BAD_GATEWAY,
        code: timedOut ? 'QWEN_REQUEST_TIMEOUT' : 'QWEN_REQUEST_FAILED',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseJsonObject(content: string): RawMemorySignalResult {
    try {
      return JSON.parse(content) as RawMemorySignalResult;
    } catch {
      const match = /\{[\s\S]*\}/.exec(content);
      if (match) {
        try {
          return JSON.parse(match[0]) as RawMemorySignalResult;
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

  private normalizeSignalResult(
    raw: RawMemorySignalResult,
    validMemoryIds: Set<string>,
    contentByMemoryId: Map<string, string>,
    createdAtByMemoryId: Map<string, string | undefined>,
  ): MemorySignalItem[] {
    if (!Array.isArray(raw.items)) {
      return [...validMemoryIds].map((memoryId) => ({
        memoryId,
        createdAt: createdAtByMemoryId.get(memoryId),
        candidates: [],
      }));
    }

    const byMemoryId = new Map<string, MemorySignalCandidate[]>();
    for (const item of raw.items) {
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const rawItem = item as Record<string, unknown>;
      const memoryId = this.normalizeText(rawItem.id ?? rawItem.memoryId, '');
      if (!validMemoryIds.has(memoryId)) {
        continue;
      }

      const candidates = this.normalizeCandidates(
        memoryId,
        rawItem.candidates,
        contentByMemoryId.get(memoryId) ?? '',
      );
      byMemoryId.set(memoryId, candidates);
    }

    return [...validMemoryIds].map((memoryId) => ({
      memoryId,
      createdAt: createdAtByMemoryId.get(memoryId),
      candidates: byMemoryId.get(memoryId) ?? [],
    }));
  }

  private normalizeCandidates(
    memoryId: string,
    value: unknown,
    memoryContent: string,
  ): MemorySignalCandidate[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemorySignalCandidate | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }
        const candidate = item as Record<string, unknown>;
        const dimension = this.normalizeDimension(candidate.dim ?? candidate.dimension);
        if (!dimension) {
          return null;
        }
        const evidenceQuote = this.buildEvidenceText(memoryContent);
        const summary = this.normalizeSummary(candidate.summary, evidenceQuote);

        return {
          evidenceId: this.buildEvidenceId(memoryId, dimension, evidenceQuote),
          dimension,
          summary,
          evidenceQuote,
        };
      })
      .filter((item): item is MemorySignalCandidate => item !== null)
      .slice(0, MAX_CANDIDATES_PER_MEMORY);
  }

  private buildEvidenceId(
    memoryId: string,
    dimension: MemorySignalDimension,
    evidenceQuote: string,
  ): string {
    let hash = 2166136261;
    const source = `${memoryId}|${dimension}|${evidenceQuote}`;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `ev_${(hash >>> 0).toString(36)}`;
  }

  private normalizeSummary(value: unknown, evidenceQuote: string): string {
    const summary = this.normalizeText(value, '').slice(0, 40);
    if (summary.length > 0) {
      return summary;
    }
    return evidenceQuote.slice(0, 20);
  }

  private normalizeDimension(value: unknown): MemorySignalDimension | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    return DIMENSIONS.has(normalized as MemorySignalDimension)
      ? normalized as MemorySignalDimension
      : null;
  }

  private buildPromptMemories(memories: DeepAnalysisMemorySnapshot[]): PromptMemory[] {
    const promptMemories: PromptMemory[] = [];
    let remainingContentChars = MAX_BATCH_CONTENT_CHARS;

    for (const memory of memories) {
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
      promptMemories.push(promptMemory);
      remainingContentChars -= promptMemory.text.length;
    }

    return promptMemories;
  }

  private toPromptMemory(
    memory: DeepAnalysisMemorySnapshot,
    maxContentChars: number,
  ): PromptMemory {
    const trimmed = this.trimForSignalExtraction(memory.content, maxContentChars);
    return {
      id: memory.id,
      text: trimmed.content,
    };
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

  private buildEvidenceText(memoryContent: string): string {
    return memoryContent.slice(0, 280);
  }

  private normalizeText(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value.trim().slice(0, 1000) : fallback;
  }

}
