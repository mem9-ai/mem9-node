import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';
import { AppError } from '@mem9/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import type { AnalyzeMemorySourceDto } from './dto/analyze-memory-source.dto';
import { Mem9SourceService } from './mem9-source.service';

export type MemorySignalDimension = 'long_term_goal' | 'focus_area' | 'emotion';

export type LongTermGoalLabel =
  | 'exam_goal'
  | 'learning_goal'
  | 'career_goal'
  | 'health_goal'
  | 'habit_goal'
  | 'financial_goal'
  | 'relationship_goal'
  | 'personal_growth_goal'
  | 'other_goal';

export type FocusAreaLabel =
  | 'learning'
  | 'work'
  | 'health'
  | 'relationship'
  | 'finance'
  | 'productivity'
  | 'project'
  | 'memory_analysis'
  | 'life_management'
  | 'self_growth'
  | 'other_focus';

export type EmotionSignalLabel =
  | 'joy'
  | 'sadness'
  | 'anger'
  | 'fear'
  | 'anxiety'
  | 'stress'
  | 'fatigue'
  | 'frustration'
  | 'calm'
  | 'anticipation'
  | 'relief'
  | 'confusion'
  | 'neutral'
  | 'uncertain';

export interface MemorySignalCandidate {
  dimension: MemorySignalDimension;
  label: LongTermGoalLabel | FocusAreaLabel | EmotionSignalLabel;
  confidence: number;
  evidenceQuote: string;
}

export interface MemorySignalItem {
  memoryId: string;
  candidates: MemorySignalCandidate[];
}

export interface AnalyzeMemorySourceResponse {
  total: number;
  limit: number;
  offset: number;
  model: string;
  items: MemorySignalItem[];
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

const MAX_CONTENT_CHARS = 12000;
const MAX_BATCH_CONTENT_CHARS = 60000;
const MAX_CANDIDATES_PER_MEMORY = 3;

const DIMENSIONS = new Set<MemorySignalDimension>([
  'long_term_goal',
  'focus_area',
  'emotion',
]);

const LABELS_BY_DIMENSION: Record<MemorySignalDimension, Set<string>> = {
  long_term_goal: new Set<LongTermGoalLabel>([
    'exam_goal',
    'learning_goal',
    'career_goal',
    'health_goal',
    'habit_goal',
    'financial_goal',
    'relationship_goal',
    'personal_growth_goal',
    'other_goal',
  ]),
  focus_area: new Set<FocusAreaLabel>([
    'learning',
    'work',
    'health',
    'relationship',
    'finance',
    'productivity',
    'project',
    'memory_analysis',
    'life_management',
    'self_growth',
    'other_focus',
  ]),
  emotion: new Set<EmotionSignalLabel>([
    'joy',
    'sadness',
    'anger',
    'fear',
    'anxiety',
    'stress',
    'fatigue',
    'frustration',
    'calm',
    'anticipation',
    'relief',
    'confusion',
    'neutral',
    'uncertain',
  ]),
};

const MEMORY_SIGNAL_SYSTEM_PROMPT = [
  '你是 memory 多维候选信号提取器。',
  '',
  '任务：阅读输入 memories，只提取与三个维度相关的候选信号：long_term_goal、focus_area、emotion。',
  '',
  '核心原则：',
  '- 第一轮只做候选路由，不做总结、趋势、人格判断。',
  '- 三个维度独立判断，不能从一个维度推导另一个维度。',
  '- 只有原文有直接证据时才能输出 candidate。',
  '- 没有明确证据时 candidates 为空。',
  '- 每条 memory 最多 3 个 candidates，只保留证据最强的。',
  '- 每个 candidate 必须有原文 evidenceQuote，尽量短。',
  '- 如果 contentTruncated 为 true，只能基于输入中实际保留的文本做判断。',
  '- 不要医疗诊断。',
  '- 不要 markdown，只返回 JSON。',
  '',
  '维度定义：',
  '',
  'long_term_goal：长期目标、备考、职业规划、健康目标、习惯建设、持续性计划。必须体现持续性、未来目标或较长周期。',
  '不要把一次性任务、当前工作项、临时希望误判为长期目标。',
  '健康习惯如果只是“先保持”“暂时做到”，应优先归为 focus_area: health，不要归为 long_term_goal。',
  '“希望先把某功能跑通”这类短期交付目标，应优先归为 focus_area: project 或 memory_analysis，不要归为 long_term_goal。',
  '',
  'focus_area：近期关注点、正在投入精力的问题、反复处理的话题、当前项目或主题。可以是短期。',
  '',
  'emotion：用户自身表达出的情绪或状态。不要把被描述对象的情绪当成用户情绪。区分过去和当前，允许混合情绪。',
  '',
  '允许 labels：',
  'long_term_goal: exam_goal, learning_goal, career_goal, health_goal, habit_goal, financial_goal, relationship_goal, personal_growth_goal, other_goal',
  'focus_area: learning, work, health, relationship, finance, productivity, project, memory_analysis, life_management, self_growth, other_focus',
  'emotion: joy, sadness, anger, fear, anxiety, stress, fatigue, frustration, calm, anticipation, relief, confusion, neutral, uncertain',
  '',
  '输出 JSON：',
  '{"items":[{"memoryId":"string","candidates":[{"dimension":"long_term_goal | focus_area | emotion","label":"string","confidence":0.0,"evidenceQuote":"string"}]}]}',
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
    this.ensureQwenConfigured();

    const page = await this.source.fetchMemories(apiKey, dto.limit, dto.offset);
    const allMemoryIds = page.memories.map((memory) => memory.id);
    const memories = this.buildPromptMemories(page.memories);
    if (memories.length === 0) {
      return {
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        model: this.config.analysis.qwenModel!,
        items: allMemoryIds.map((memoryId) => ({
          memoryId,
          candidates: [],
        })),
      };
    }

    const content = await this.callQwenForCandidates(memories, dto.lang ?? 'zh-CN');
    const parsed = this.parseJsonObject(content);
    const items = this.normalizeSignalResult(
      parsed,
      new Set(allMemoryIds),
      new Map(memories.map((memory) => [memory.id, memory.content])),
    );

    return {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      model: this.config.analysis.qwenModel!,
      items,
    };
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
  ): MemorySignalItem[] {
    if (!Array.isArray(raw.items)) {
      return [...validMemoryIds].map((memoryId) => ({
        memoryId,
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
        const label = this.normalizeLabel(dimension, candidate.label);
        if (!label) {
          return null;
        }
        const evidenceQuote = this.normalizeText(candidate.evidenceQuote, '').slice(0, 280);
        if (!this.isEvidenceInContent(evidenceQuote, memoryContent)) {
          return null;
        }

        return {
          dimension,
          label,
          confidence: this.clampNumber(candidate.confidence, 0, 1, 0.5),
          evidenceQuote,
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

  private normalizeLabel(
    dimension: MemorySignalDimension,
    value: unknown,
  ): MemorySignalCandidate['label'] | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    return LABELS_BY_DIMENSION[dimension].has(normalized)
      ? normalized as MemorySignalCandidate['label']
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
