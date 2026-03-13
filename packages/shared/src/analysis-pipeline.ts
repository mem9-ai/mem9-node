import type {
  AggregateMergeInput,
  AnalysisCategory,
  BatchSummary,
  MemoryInput,
  TaxonomyRuleDefinition,
} from '@mem9/contracts';
import { ANALYSIS_CATEGORIES } from '@mem9/contracts';

import { sha256Hex } from './hash';

export interface NormalizedMemory {
  id: string;
  content: string;
  normalizedContent: string;
  contentHash: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export interface AnalyzedMemory extends NormalizedMemory {
  category: AnalysisCategory;
  confidence: number;
  tags: string[];
}

const stopWords = new Set(['的', '了', '和', '是', '在', '我', '也', 'to', 'the', 'a', 'an', 'and', 'or']);

function getNodeJieba():
  | {
      cut(text: string): string[];
    }
  | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    return require('nodejieba') as { cut(text: string): string[] };
  } catch {
    return undefined;
  }
}

function tokenize(text: string, lang: string): string[] {
  const jieba = getNodeJieba();

  if (jieba !== undefined && lang.toLowerCase().startsWith('zh')) {
    return jieba.cut(text).map((token) => token.trim()).filter(Boolean);
  }

  const segmenter = new Intl.Segmenter(lang, { granularity: 'word' });
  return Array.from(segmenter.segment(text))
    .map((part) => part.segment.trim())
    .filter((part) => part.length > 1 && /[\p{L}\p{N}]/u.test(part));
}

export function normalizeMemory(memory: MemoryInput): NormalizedMemory {
  const normalizedContent = memory.content.replace(/\s+/g, ' ').trim().toLowerCase();

  return {
    id: memory.id,
    content: memory.content,
    normalizedContent,
    contentHash: sha256Hex(normalizedContent),
    createdAt: new Date(memory.createdAt),
    metadata: memory.metadata ?? {},
  };
}

function matchesRule(content: string, rule: TaxonomyRuleDefinition): boolean {
  switch (rule.matchType) {
    case 'keyword':
      return content.includes(rule.pattern.toLowerCase());
    case 'phrase':
      return content.includes(rule.pattern.toLowerCase());
    case 'regex':
      return new RegExp(rule.pattern, 'iu').test(content);
    default:
      return false;
  }
}

export function classifyMemory(
  memory: NormalizedMemory,
  rules: TaxonomyRuleDefinition[],
  lang: string,
): AnalyzedMemory {
  const tokens = tokenize(memory.content, lang)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !stopWords.has(token));
  const tagCounts = new Map<string, number>();

  for (const token of tokens) {
    tagCounts.set(token, (tagCounts.get(token) ?? 0) + 1);
  }

  const matchingRules = rules
    .filter((rule) => rule.enabled)
    .filter((rule) => matchesRule(memory.normalizedContent, rule));

  const categoryScores = new Map<AnalysisCategory, number>();

  for (const category of ANALYSIS_CATEGORIES) {
    categoryScores.set(category, 0);
  }

  for (const rule of matchingRules) {
    categoryScores.set(rule.category, (categoryScores.get(rule.category) ?? 0) + rule.weight);
  }

  const sortedCategories = [...categoryScores.entries()].sort((left, right) => right[1] - left[1]);
  const [topCategory, topScore] = sortedCategories[0] ?? ['activity', 0];
  const category = topScore > 0 ? topCategory : inferFallbackCategory(tokens);
  const totalScore = sortedCategories.reduce((sum, [, score]) => sum + score, 0);
  const confidence = totalScore > 0 ? Number((topScore / totalScore).toFixed(2)) : 0.35;
  const tags = [...tagCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  return {
    ...memory,
    category,
    confidence,
    tags,
  };
}

function inferFallbackCategory(tokens: string[]): AnalysisCategory {
  const joined = tokens.join(' ');

  if (/(feel|happy|sad|angry|焦虑|开心|难过)/iu.test(joined)) {
    return 'emotion';
  }

  if (/(喜欢|偏好|prefer|love|hate|想要)/iu.test(joined)) {
    return 'preference';
  }

  if (/(身份|我是|role|职业|engineer|founder)/iu.test(joined)) {
    return 'identity';
  }

  if (/(旅行|trip|experience|经历|去过)/iu.test(joined)) {
    return 'experience';
  }

  return 'activity';
}

export function analyzeBatch(input: {
  batchIndex: number;
  memories: NormalizedMemory[];
  rules: TaxonomyRuleDefinition[];
  lang: string;
}): AggregateMergeInput {
  const categoryCounts = {
    identity: 0,
    emotion: 0,
    preference: 0,
    experience: 0,
    activity: 0,
  } satisfies Record<AnalysisCategory, number>;
  const tagCounts: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};
  const analyzedMemories = input.memories.map((memory) => classifyMemory(memory, input.rules, input.lang));

  for (const memory of analyzedMemories) {
    categoryCounts[memory.category] += 1;

    for (const tag of memory.tags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      topicCounts[tag] = (topicCounts[tag] ?? 0) + 1;
    }
  }

  const topCategories = Object.entries(categoryCounts)
    .map(([category, count]) => ({
      category: category as AnalysisCategory,
      count,
      confidence: analyzedMemories.length === 0 ? 0 : Number((count / analyzedMemories.length).toFixed(2)),
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 3);

  const topTags = Object.entries(tagCounts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  const summarySnapshot = topCategories
    .filter((card) => card.count > 0)
    .map((card) => `${card.category}:${card.count}`);

  const batchResult: BatchSummary = {
    batchIndex: input.batchIndex,
    status: 'SUCCEEDED',
    memoryCount: input.memories.length,
    processedMemories: input.memories.length,
    topCategories,
    topTags,
  };

  return {
    batchIndex: input.batchIndex,
    expectedTotalBatches: 0,
    processedMemories: input.memories.length,
    categoryCounts,
    tagCounts,
    topicCounts,
    summarySnapshot,
    batchResult,
  };
}

export function canonicalizeBatchPayload(memoryCount: number, memories: MemoryInput[]): string {
  const canonicalMemories = memories.map((memory) => ({
    id: memory.id,
    content: memory.content,
    createdAt: memory.createdAt,
    metadata: memory.metadata ?? {},
  }));

  return JSON.stringify({
    memoryCount,
    memories: canonicalMemories,
  });
}
