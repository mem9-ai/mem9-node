import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';
import { AppError } from '@mem9/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import type { AnalyzeMemorySourceDto } from './dto/analyze-memory-source.dto';
import { Mem9SourceService } from './mem9-source.service';

export type MemorySignalDimension =
  | 'long_term_goal'
  | 'focus_area'
  | 'emotion'
  | 'preference_signal'
  | 'growth_signal';

export interface MemorySignalCandidate {
  dimension: MemorySignalDimension;
  confidence: number;
  evidenceQuote: string;
  topicKey: string;
  topic: string;
  state: string;
  intensity: number;
  tags: string[];
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
  memoryId: string;
  createdAt?: string;
  quote: string;
  confidence: number;
}

export interface MemoryAnalysisTimelinePoint {
  at?: string;
  state: string;
  intensity: number;
  transitionFromPrevious?: {
    type: 'initial' | 'strengthened' | 'weakened' | 'persisted';
    fromState?: string;
    fromIntensity?: number;
    toState: string;
    toIntensity: number;
  };
  evidenceMemoryIds: string[];
}

export interface MemoryAnalysisChangeDetail {
  timeline: MemoryAnalysisTimelinePoint[];
  evidence: MemoryAnalysisEvidence[];
}

export interface MemoryAnalysisTopicChange {
  id: string;
  dimension: MemorySignalDimension;
  topicKey: string;
  topic: string;
  currentState: string;
  currentIntensity: number;
  changeType: 'single' | 'strengthened' | 'weakened' | 'persisted';
  status: 'high' | 'needs_confirm' | 'low_confidence';
  confidence: number;
  relatedMemoryCount: number;
  tags: string[];
  detail: MemoryAnalysisChangeDetail;
}

export interface MemoryAnalysisDimensionGroup {
  dimension: MemorySignalDimension;
  topics: MemoryAnalysisTopicChange[];
}

export interface AnalyzeMemorySourceChangesResponse extends AnalyzeMemorySourceResponse {
  dimensions: MemoryAnalysisDimensionGroup[];
}

interface QwenChatCompletionPayload {
  model?: string;
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
  content: string;
  createdAt?: string;
  memoryType?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  contentTruncated?: boolean;
  truncationStrategy?: 'head_tail';
}

interface SignalObservation {
  dimension: MemorySignalDimension;
  topic: string;
  topicKey: string;
  state: string;
  intensity: number;
  tags: string[];
  evidence: MemoryAnalysisEvidence;
}

const MAX_CONTENT_CHARS = 12000;
const MAX_BATCH_CONTENT_CHARS = 60000;
const MAX_CANDIDATES_PER_MEMORY = 3;

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
  'Task: read the input memories and extract candidate signals for exactly five dimensions: long_term_goal, focus_area, emotion, preference_signal, growth_signal.',
  '',
  'Core rules:',
  '- This is the first-pass extraction step only. Do not summarize, infer trends, judge personality, or produce final analysis.',
  '- Prefer recall over precision. If a memory has direct evidence for any dimension, keep a candidate.',
  '- Judge each dimension independently. Do not infer one dimension from another.',
  '- Output a candidate only when it is directly supported by the input text.',
  '- If there is no direct evidence, return an empty candidates array for that memory.',
  '- Return at most 3 candidates per memory, keeping the strongest evidence.',
  '- Every candidate must include a short evidenceQuote copied from the input memory.',
  '- Every candidate must include topicKey, topic, state, intensity, and tags.',
  '- topicKey must be stable snake_case English. Use the same topicKey for the same underlying topic across memories in this request.',
  '- topic must be a concise noun phrase derived from the evidence, not a broad dimension name.',
  '- state must describe the current observed stage or condition in a concise phrase.',
  '- intensity is an integer from 1 to 5. It is a dimension-local strength score, not a medical or universal severity score.',
  '- tags are short structured descriptors derived from the evidence. Keep 1 to 5 short tags.',
  '- If contentTruncated is true, only judge from the retained input text.',
  '- topic/state/tags are structured metadata. Do not use them to suppress an evidence-backed candidate.',
  '- Do not drop a candidate just because it does not fit a predefined label.',
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
  '{"items":[{"memoryId":"string","candidates":[{"dimension":"long_term_goal | focus_area | emotion | preference_signal | growth_signal","confidence":0.0,"evidenceQuote":"string","topicKey":"stable_snake_case","topic":"string","state":"string","intensity":1,"tags":["string"]}]}]}',
].join('\n');

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
  ): Promise<AnalyzeMemorySourceResponse> {
    const page = await this.source.fetchMemories(apiKey, dto.limit, dto.offset);
    const allMemoryIds = page.memories.map((memory) => memory.id);
    const createdAtByMemoryId = new Map(page.memories.map((memory) => [memory.id, memory.createdAt]));
    const memories = this.buildPromptMemories(page.memories);
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

    const content = await this.callQwenForCandidates(memories, dto.lang ?? 'zh-CN');
    const parsed = this.parseJsonObject(content);
    const items = this.normalizeSignalResult(
      parsed,
      new Set(allMemoryIds),
      new Map(memories.map((memory) => [memory.id, memory.content])),
      createdAtByMemoryId,
    );

    return {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      model: this.config.analysis.qwenModel!,
      items,
    };
  }

  public async analyzeSourceChanges(
    apiKey: string,
    dto: AnalyzeMemorySourceDto,
  ): Promise<AnalyzeMemorySourceChangesResponse> {
    const firstPass = await this.analyzeSource(apiKey, dto);
    return {
      ...firstPass,
      dimensions: this.buildChangeDimensions(firstPass.items),
    };
  }

  private buildChangeDimensions(items: MemorySignalItem[]): MemoryAnalysisDimensionGroup[] {
    const observations = this.buildSignalObservations(items);
    const byDimension = this.groupBy(observations, (item) => item.dimension);

    return [...DIMENSIONS]
      .map((dimension) => {
        const dimensionObservations = byDimension.get(dimension) ?? [];
        const topicGroups = this.groupBy(dimensionObservations, (item) => item.topicKey);
        const topics = [...topicGroups.values()]
          .map((group) => this.buildTopicChange(dimension, group))
          .sort((left, right) => {
            const leftAt = left.detail.timeline[0]?.at ?? '';
            const rightAt = right.detail.timeline[0]?.at ?? '';
            return leftAt.localeCompare(rightAt);
          });

        return {
          dimension,
          topics,
        };
      })
      .filter((group) => group.topics.length > 0);
  }

  private buildSignalObservations(items: MemorySignalItem[]): SignalObservation[] {
    const observations: SignalObservation[] = [];

    for (const item of items) {
      for (const candidate of item.candidates) {
        const topic = candidate.topic || this.defaultTopic(candidate.dimension);
        observations.push({
          dimension: candidate.dimension,
          topic,
          topicKey: candidate.topicKey || this.slugify(topic),
          state: candidate.state || 'observed',
          intensity: candidate.intensity,
          tags: candidate.tags,
          evidence: {
            memoryId: item.memoryId,
            createdAt: item.createdAt,
            quote: candidate.evidenceQuote,
            confidence: candidate.confidence,
          },
        });
      }
    }

    return observations.sort((left, right) => (left.evidence.createdAt ?? '').localeCompare(right.evidence.createdAt ?? ''));
  }

  private buildTopicChange(
    dimension: MemorySignalDimension,
    observations: SignalObservation[],
  ): MemoryAnalysisTopicChange {
    const sorted = [...observations].sort((left, right) => (left.evidence.createdAt ?? '').localeCompare(right.evidence.createdAt ?? ''));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const confidence = this.roundConfidence(Math.max(...sorted.map((item) => item.evidence.confidence)));
    const tags = this.unique(sorted.flatMap((item) => item.tags)).slice(0, 5);

    return {
      id: `${dimension}-${first.topicKey}`,
      dimension,
      topicKey: first.topicKey,
      topic: first.topic,
      currentState: last.state,
      currentIntensity: last.intensity,
      changeType: this.topicChangeType(first, last, sorted.length),
      status: this.topicStatus(sorted.length, confidence),
      confidence,
      relatedMemoryCount: this.unique(sorted.map((item) => item.evidence.memoryId)).length,
      tags,
      detail: {
        timeline: this.buildTimeline(sorted),
        evidence: sorted.map((item) => item.evidence),
      },
    };
  }

  private buildTimeline(observations: SignalObservation[]): MemoryAnalysisTimelinePoint[] {
    return observations.map((item, index) => {
      const previous = index > 0 ? observations[index - 1] : undefined;
      return {
        at: item.evidence.createdAt,
        state: item.state,
        intensity: item.intensity,
        transitionFromPrevious: this.buildTransition(previous, item),
        evidenceMemoryIds: [item.evidence.memoryId],
      };
    });
  }

  private topicChangeType(
    first: SignalObservation,
    last: SignalObservation,
    count: number,
  ): MemoryAnalysisTopicChange['changeType'] {
    if (count === 1) {
      return 'single';
    }

    if (last.intensity > first.intensity) {
      return 'strengthened';
    }
    if (last.intensity < first.intensity) {
      return 'weakened';
    }
    return 'persisted';
  }

  private buildTransition(
    previous: SignalObservation | undefined,
    current: SignalObservation,
  ): MemoryAnalysisTimelinePoint['transitionFromPrevious'] {
    if (!previous) {
      return {
        type: 'initial',
        toState: current.state,
        toIntensity: current.intensity,
      };
    }

    if (current.intensity > previous.intensity) {
      return {
        type: 'strengthened',
        fromState: previous.state,
        fromIntensity: previous.intensity,
        toState: current.state,
        toIntensity: current.intensity,
      };
    }

    if (current.intensity < previous.intensity) {
      return {
        type: 'weakened',
        fromState: previous.state,
        fromIntensity: previous.intensity,
        toState: current.state,
        toIntensity: current.intensity,
      };
    }

    return {
      type: 'persisted',
      fromState: previous.state,
      fromIntensity: previous.intensity,
      toState: current.state,
      toIntensity: current.intensity,
    };
  }

  private topicStatus(count: number, confidence: number): MemoryAnalysisTopicChange['status'] {
    if (count >= 2 && confidence >= 0.85) {
      return 'high';
    }
    if (confidence < 0.7) {
      return 'low_confidence';
    }
    return 'needs_confirm';
  }

  private defaultTopic(dimension: MemorySignalDimension): string {
    return dimension;
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'unknown';
  }

  private unique<T>(values: T[]): T[] {
    return [...new Set(values)];
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

    try {
      const response = await fetch(`${this.config.analysis.qwenApiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.analysis.qwenApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
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
              content: JSON.stringify({
                lang,
                memories,
              }),
            },
          ],
        }),
      });
      const payload = await response.json().catch(() => null) as QwenChatCompletionPayload | null;

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
      const memoryId = this.normalizeText(rawItem.memoryId, '');
      if (!validMemoryIds.has(memoryId)) {
        continue;
      }

      const candidates = this.normalizeCandidates(
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

  private normalizeCandidates(value: unknown, memoryContent: string): MemorySignalCandidate[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): MemorySignalCandidate | null => {
        if (item === null || typeof item !== 'object') {
          return null;
        }
        const candidate = item as Record<string, unknown>;
        const dimension = this.normalizeDimension(candidate.dimension);
        if (!dimension) {
          return null;
        }
        const evidenceQuote = this.normalizeText(candidate.evidenceQuote, '').slice(0, 280);
        if (!this.isEvidenceInContent(evidenceQuote, memoryContent)) {
          return null;
        }

        return {
          dimension,
          confidence: this.clampNumber(candidate.confidence, 0, 1, 0.5),
          evidenceQuote,
          topicKey: this.normalizeTopicKey(candidate.topicKey),
          topic: this.normalizeText(candidate.topic, dimension).slice(0, 80),
          state: this.normalizeText(candidate.state, 'observed').slice(0, 80),
          intensity: Math.round(this.clampNumber(candidate.intensity, 1, 5, 3)),
          tags: this.normalizeTags(candidate.tags),
        };
      })
      .filter((item): item is MemorySignalCandidate => item !== null)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_CANDIDATES_PER_MEMORY);
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
      remainingContentChars -= promptMemory.content.length;
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
      content: trimmed.content,
      createdAt: memory.createdAt,
      memoryType: memory.memoryType,
      tags: memory.tags ?? [],
      metadata: this.pickRelevantMetadata(memory.metadata),
      contentTruncated: trimmed.truncated || undefined,
      truncationStrategy: trimmed.truncated ? 'head_tail' : undefined,
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

  private pickRelevantMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!metadata) {
      return {};
    }

    const result: Record<string, unknown> = {};
    for (const key of ['role', 'source', 'session_id', 'content_type']) {
      const value = metadata[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result[key] = value;
      }
    }

    return result;
  }

  private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, numeric));
  }

  private normalizeText(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value.trim().slice(0, 1000) : fallback;
  }

  private normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return this.unique(
      value
        .map((item) => this.normalizeText(item, '').slice(0, 32))
        .filter((item) => item.length > 0),
    ).slice(0, 5);
  }

  private normalizeTopicKey(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }

    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  private isEvidenceInContent(evidenceQuote: string, content: string): boolean {
    if (evidenceQuote.length === 0 || content.length === 0) {
      return false;
    }

    const normalizedEvidence = this.normalizeWhitespace(evidenceQuote);
    const normalizedContent = this.normalizeWhitespace(content);
    return normalizedEvidence.length > 0 && normalizedContent.includes(normalizedEvidence);
  }

  private normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }
}
