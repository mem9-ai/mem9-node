import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type {
  DeepAnalysisCandidateEdge,
  DeepAnalysisCandidateNode,
  DeepAnalysisDiscoveryCard,
  DeepAnalysisEntityGroup,
  DeepAnalysisEvidenceHighlight,
  DeepAnalysisMemorySnapshot,
  DeepAnalysisQualityIssue,
  DeepAnalysisRelationship,
  DeepAnalysisReportDocument,
  DeepAnalysisReportMessage,
  DeepAnalysisReportPreview,
  DeepAnalysisThemeItem,
} from '@mem9/contracts';
import {
  AnalysisRepository,
  AppError,
  S3PayloadStorageService,
  gunzipJson,
  normalizeMemory,
} from '@mem9/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeepAnalysisReportStage, DeepAnalysisReportStatus, Prisma } from '@prisma/client';

import {
  QwenDeepAnalysisService,
  type QwenAuditStage,
  type QwenJsonResult,
} from './qwen-deep-analysis.service';

interface SourceSnapshotPayload {
  fetchedAt: string;
  memoryCount: number;
  memories: DeepAnalysisMemorySnapshot[];
}

interface ChunkThemeSignal {
  name: string;
  memoryIds: string[];
}

interface ChunkEntitySignals {
  people: string[];
  teams: string[];
  projects: string[];
  tools: string[];
  places: string[];
}

interface ChunkPersonaSignals {
  workingStyle: string[];
  goals: string[];
  preferences: string[];
  constraints: string[];
  decisionSignals: string[];
  notableRoutines: string[];
  contradictionsOrTensions: string[];
}

interface ChunkInsight {
  summary: string;
  themes: ChunkThemeSignal[];
  entities: ChunkEntitySignals;
  personaSignals: ChunkPersonaSignals;
  relationships: DeepAnalysisRelationship[];
}

interface PreparedMemory {
  id: string;
  content: string;
  contentHash: string;
  createdAt: Date;
  tags: string[];
}

interface PreparedCorpus {
  originalCount: number;
  deduplicatedCount: number;
  uniqueMemories: PreparedMemory[];
  duplicateClusters: Array<{
    canonicalMemoryId: string;
    duplicateMemoryIds: string[];
  }>;
}

interface CounterValue {
  count: number;
  evidenceMemoryIds: string[];
}

interface SignalEntry {
  text: string;
  memoryId: string;
}

interface CorpusStats {
  tokenCounts: Map<string, number>;
  phraseCounts: Map<string, number>;
  personCounters: Map<string, CounterValue>;
  teamCounters: Map<string, CounterValue>;
  projectCounters: Map<string, CounterValue>;
  toolCounters: Map<string, CounterValue>;
  placeCounters: Map<string, CounterValue>;
  workingStyleSignals: SignalEntry[];
  goalSignals: SignalEntry[];
  preferenceSignals: SignalEntry[];
  constraintSignals: SignalEntry[];
  decisionSignals: SignalEntry[];
  routineSignals: SignalEntry[];
  lowQualityExamples: DeepAnalysisQualityIssue[];
  relationships: DeepAnalysisRelationship[];
}

interface PersonaSummarySection {
  summary: string;
  workingStyle: string[];
  goals: string[];
  preferences: string[];
  constraints: string[];
  decisionSignals: string[];
  notableRoutines: string[];
  contradictionsOrTensions: string[];
  evidenceHighlights: DeepAnalysisEvidenceHighlight[];
}

interface CorpusSignals {
  persona: PersonaSummarySection;
  themeHighlights: DeepAnalysisThemeItem[];
  entities: {
    people: DeepAnalysisEntityGroup[];
    teams: DeepAnalysisEntityGroup[];
    projects: DeepAnalysisEntityGroup[];
    tools: DeepAnalysisEntityGroup[];
    places: DeepAnalysisEntityGroup[];
  };
  relationships: DeepAnalysisRelationship[];
  lowQualityExamples: DeepAnalysisQualityIssue[];
  duplicateMemoryCount: number;
  coverageGaps: string[];
  discoveries: DeepAnalysisDiscoveryCard[];
  recommendations: string[];
  productSignals: {
    candidateNodes: DeepAnalysisCandidateNode[];
    candidateEdges: DeepAnalysisCandidateEdge[];
    searchSeeds: string[];
  };
}

interface InternalCommentAggregate {
  requestCount: number;
  successCount: number;
  failureCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface InternalCommentCall {
  stage: QwenAuditStage;
  index: number;
  success: boolean;
  httpStatus: number | null;
  parseSucceeded: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageMissing: boolean;
  requestedAt: string;
  finishedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface InternalCommentEvent {
  at: string;
  level: 'info' | 'warn' | 'error';
  stage: string;
  event: string;
  fields: Record<string, string | number | boolean | null>;
}

interface InternalCommentRuntimeError {
  at: string;
  stage: string;
  errorName: string;
  errorCode: string | null;
  errorMessage: string;
  stack: string | null;
  isTrimError: boolean;
}

interface InternalCommentPayload {
  version: 1;
  provider: 'qwen';
  model: string;
  aggregate: InternalCommentAggregate;
  calls: InternalCommentCall[];
  events: InternalCommentEvent[];
  runtimeErrors: InternalCommentRuntimeError[];
}

interface ChunkAnalysisSummary {
  totalChunks: number;
  successCount: number;
  failureCount: number;
}

interface ChunkAnalysisOutcome {
  insights: ChunkInsight[];
  summary: ChunkAnalysisSummary;
}

interface ChunkExecutionResult {
  index: number;
  chunkSize: number;
  durationMs: number;
  fallbackUsed: boolean;
  result: QwenJsonResult<ChunkInsight>;
  insight: ChunkInsight;
}

interface SynthesisOutcome {
  report: DeepAnalysisReportDocument;
  durationMs: number;
  fallbackUsed: boolean;
  errorCode: string | null;
}

const TOOL_HINTS = [
  'react', 'typescript', 'javascript', 'node', 'go', 'python', 'docker', 'kubernetes',
  'tidb', 'mysql', 'redis', 'neovim', 'vscode', 'github', 'gitlab', 'openai', 'qwen',
  'claude', 'terraform', 'prometheus', 'grafana', 'feishu',
] as const;
const PLACE_HINTS = [
  'shanghai', 'beijing', 'singapore', 'tokyo', 'office', 'home', 'hangzhou',
] as const;
const RELATION_PATTERNS = [
  { pattern: /\bworks with ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g, relation: 'works_with' },
  { pattern: /\bcollaborates with ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g, relation: 'collaborates_with' },
  { pattern: /\bwith ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g, relation: 'interacts_with' },
] as const;
const ACKNOWLEDGEMENT_PATTERN = /^(ok|done|noted|received|收到|好的|完成|明白了)$/iu;
const EN_STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'have', 'has', 'had', 'been',
  'were', 'was', 'will', 'would', 'should', 'could', 'there', 'their', 'about', 'after',
  'before', 'because', 'while', 'where', 'when', 'what', 'which', 'then', 'than', 'them',
  'they', 'your', 'ours', 'ourselves', 'myself', 'herself', 'himself', 'itself', 'user',
  'users', 'agent', 'assistant', 'self', 'team', 'project', 'task', 'system', 'memory',
  'workflow', 'workflows', 'group', 'thing', 'things', 'item', 'items', 'info', 'information',
  'data', 'using', 'used', 'use', 'like', 'just', 'more', 'less', 'very', 'also', 'into',
  'over', 'under', 'through', 'across', 'within', 'without', 'each', 'every',
] as const);
const ZH_STOPWORDS = new Set<string>([
  '的', '了', '和', '是', '在', '与', '及', '一个', '这个', '那个', '需要', '可以', '进行',
  '通过', '我们', '他们', '自己', '用户', '团队', '项目', '系统', '记忆', '工作流', '一些',
  '这种', '这个人', '这个团队', '事情', '内容', '信息', '数据', '以及', '然后', '这里',
] as const);
const DISALLOWED_THEME_TERMS = new Set<string>([
  ...EN_STOPWORDS,
  ...ZH_STOPWORDS,
  'end',
]);
const DISALLOWED_ENTITY_TERMS = new Set<string>([
  ...EN_STOPWORDS,
  ...ZH_STOPWORDS,
  'the',
  'user',
  'assistant',
  'self',
  'team',
  'group',
  'platform',
  'workflow',
  'project',
  'task',
  'system',
  'memory',
]);
const DISALLOWED_PROJECT_TAGS = new Set<string>([
  'work', 'plan', 'task', 'tasks', 'project', 'projects', 'memory', 'workflow', 'agent', 'user',
]);
const CHUNK_SIZE = 180;
const CHUNK_ANALYSIS_PROGRESS_START = 35;
const CHUNK_ANALYSIS_PROGRESS_END = 59;
const INTERNAL_COMMENT_STAGE_ORDER: Record<QwenAuditStage, number> = {
  chunk_analysis: 0,
  global_synthesis: 1,
};
const INTERNAL_COMMENT_EVENT_LIMIT = 80;
const INTERNAL_COMMENT_RUNTIME_ERROR_LIMIT = 10;
const INTERNAL_COMMENT_STACK_LIMIT = 4000;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sentencePreview(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function trimToString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeToken(value: unknown): string {
  return trimToString(value)?.toLowerCase() ?? '';
}

function coerceStringArray(value: unknown, limit = Number.POSITIVE_INFINITY): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  for (const item of value) {
    const trimmed = trimToString(item);
    if (!trimmed) {
      continue;
    }
    normalized.push(trimmed);
    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizeChunkRelationships(value: unknown): DeepAnalysisRelationship[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const source = trimToString(item.source);
    const relation = trimToString(item.relation);
    const target = trimToString(item.target);
    if (!source || !relation || !target) {
      return [];
    }

    return [{
      source,
      relation,
      target,
      confidence: typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? item.confidence
        : 0.5,
      evidenceMemoryIds: coerceStringArray(item.evidenceMemoryIds, 6),
      evidenceExcerpts: coerceStringArray(item.evidenceExcerpts, 4),
    }];
  });
}

function sanitizeChunkInsight(value: ChunkInsight): ChunkInsight {
  const entities: Record<string, unknown> = isRecord(value.entities) ? value.entities : {};
  const personaSignals: Record<string, unknown> = isRecord(value.personaSignals) ? value.personaSignals : {};

  return {
    summary: trimToString(value.summary) ?? '',
    themes: Array.isArray(value.themes)
      ? value.themes.flatMap((item) => {
        if (!isRecord(item)) {
          return [];
        }

        const name = trimToString(item.name);
        if (!name) {
          return [];
        }

        return [{
          name,
          memoryIds: coerceStringArray(item.memoryIds, 12),
        }];
      })
      : [],
    entities: {
      people: coerceStringArray(entities.people, 12),
      teams: coerceStringArray(entities.teams, 12),
      projects: coerceStringArray(entities.projects, 12),
      tools: coerceStringArray(entities.tools, 12),
      places: coerceStringArray(entities.places, 12),
    },
    personaSignals: {
      workingStyle: coerceStringArray(personaSignals.workingStyle, 12),
      goals: coerceStringArray(personaSignals.goals, 12),
      preferences: coerceStringArray(personaSignals.preferences, 12),
      constraints: coerceStringArray(personaSignals.constraints, 12),
      decisionSignals: coerceStringArray(personaSignals.decisionSignals, 12),
      notableRoutines: coerceStringArray(personaSignals.notableRoutines, 12),
      contradictionsOrTensions: coerceStringArray(personaSignals.contradictionsOrTensions, 12),
    },
    relationships: sanitizeChunkRelationships(value.relationships),
  };
}

function containsHan(value: string): boolean {
  return /[\p{Script=Han}]/u.test(value);
}

function isMeaningfulToken(token: string): boolean {
  const normalized = normalizeToken(token);

  if (!normalized) {
    return false;
  }

  if (/^https?:/u.test(normalized) || /^www\./u.test(normalized)) {
    return false;
  }

  if (/^\d+$/u.test(normalized)) {
    return false;
  }

  if (containsHan(normalized)) {
    return normalized.length >= 2 && !ZH_STOPWORDS.has(normalized);
  }

  return normalized.length >= 3 && !DISALLOWED_THEME_TERMS.has(normalized);
}

function tokenize(content: string): string[] {
  return content
    .split(/[^\p{L}\p{N}@#._/-]+/u)
    .map((token) => normalizeToken(token))
    .filter((token) => isMeaningfulToken(token));
}

function titleCaseWords(value: string): string {
  return value
    .split(/\s+/u)
    .map((part) => part ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part)
    .join(' ');
}

function pickTopEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'en'))
    .slice(0, limit);
}

function upsertCounter(
  map: Map<string, CounterValue>,
  label: string,
  memoryId: string,
): void {
  const current = map.get(label) ?? { count: 0, evidenceMemoryIds: [] };
  current.count += 1;
  if (!current.evidenceMemoryIds.includes(memoryId)) {
    current.evidenceMemoryIds.push(memoryId);
  }
  map.set(label, current);
}

function appendSignal(target: SignalEntry[], text: string, memoryId: string): void {
  if (!target.some((entry) => entry.text === text && entry.memoryId === memoryId)) {
    target.push({ text, memoryId });
  }
}

function buildEntityGroups(
  counters: Map<string, CounterValue>,
  limit = 8,
): DeepAnalysisEntityGroup[] {
  return [...counters.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0], 'en'))
    .slice(0, limit)
    .map(([label, data]) => ({
      label,
      count: data.count,
      evidenceMemoryIds: data.evidenceMemoryIds.slice(0, 6),
    }));
}

function extractProperNames(content: string): string[] {
  const matches = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) ?? [];
  return [...new Set(matches.filter((label) => isMeaningfulEntityLabel(label)))];
}

function extractTeamLabels(content: string): string[] {
  const labels = new Set<string>();

  for (const match of content.matchAll(/\b([A-Za-z][A-Za-z-]+)\s+(team|group)\b/gi)) {
    const name = match[1]?.trim();
    const suffix = match[2]?.trim();
    if (!name || !suffix || DISALLOWED_ENTITY_TERMS.has(normalizeToken(name))) {
      continue;
    }
    labels.add(`${titleCaseWords(name)} ${titleCaseWords(suffix)}`);
  }

  for (const hint of ['backend', 'frontend', 'platform', 'security', 'sales', 'product']) {
    if (new RegExp(`\\b${hint}\\s+team\\b`, 'i').test(content)) {
      labels.add(`${titleCaseWords(hint)} Team`);
    }
  }

  return [...labels];
}

function isMeaningfulEntityLabel(label: string): boolean {
  const normalized = normalizeToken(label);
  if (!normalized) {
    return false;
  }
  if (DISALLOWED_ENTITY_TERMS.has(normalized)) {
    return false;
  }
  if (containsHan(normalized)) {
    return normalized.length >= 2;
  }
  return normalized.length >= 3;
}

function collectMemoryPhrases(content: string): string[] {
  const tokens = tokenize(content);
  const phrases = new Set<string>();

  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(' ');
      if (phrase.length >= 7 && !DISALLOWED_THEME_TERMS.has(phrase)) {
        phrases.add(phrase);
      }
    }
  }

  return [...phrases];
}

function uniqueStrings(items: string[], limit = items.length): string[] {
  return [...new Set(items)].slice(0, limit);
}

function collectRepresentativeSignals(entries: SignalEntry[], limit = 5): string[] {
  return uniqueStrings(entries.map((entry) => entry.text), limit);
}

function buildEvidenceHighlights(entries: SignalEntry[], limit = 4): DeepAnalysisEvidenceHighlight[] {
  return entries.slice(0, limit).map((entry, index) => ({
    title: `Evidence ${index + 1}`,
    detail: entry.text,
    memoryIds: [entry.memoryId],
  }));
}

function buildContradictions(stats: CorpusStats): string[] {
  const combined = [
    ...stats.workingStyleSignals,
    ...stats.preferenceSignals,
    ...stats.constraintSignals,
    ...stats.decisionSignals,
  ].map((entry) => normalizeToken(entry.text)).join(' ');
  const contradictions: string[] = [];

  if (/(concise|save token|节省|简洁)/u.test(combined) && /(detail|详细|全面|完整)/u.test(combined)) {
    contradictions.push('The corpus shows a tension between concise communication and preserving rich implementation detail.');
  }
  if (/(automate|automation|自动化|脚本)/u.test(combined) && /(manual|手动|人工)/u.test(combined)) {
    contradictions.push('The user values automation but still keeps manual control in sensitive workflows.');
  }
  if (/(fast|speed|效率|迅速)/u.test(combined) && /(stable|quality|严格|严谨|正确)/u.test(combined)) {
    contradictions.push('The corpus balances speed and efficiency against reliability and correctness concerns.');
  }

  return contradictions;
}

function buildCoverageGaps(
  peopleCount: number,
  projectCount: number,
  toolCount: number,
  routineCount: number,
  decisionCount: number,
): string[] {
  const gaps: string[] = [];

  if (peopleCount < 3) {
    gaps.push('People and collaborator mentions are sparse; relationship coverage may still be incomplete.');
  }
  if (projectCount < 3) {
    gaps.push('Project-level labels are still thin; clearer project naming would improve grouping quality.');
  }
  if (toolCount < 3) {
    gaps.push('Tool and environment references are limited; operational context may be underrepresented.');
  }
  if (routineCount < 2) {
    gaps.push('Routines and temporal habits are under-specified, so behavioral patterns may be incomplete.');
  }
  if (decisionCount < 2) {
    gaps.push('Decision rationale is lightly captured; more explicit tradeoff memories would deepen future persona analysis.');
  }

  return gaps;
}

function buildRecommendations(
  duplicateMemoryCount: number,
  lowQualityCount: number,
  relationshipCount: number,
  contradictionsOrTensions: string[],
): string[] {
  const recommendations: string[] = [];

  if (duplicateMemoryCount > 0) {
    recommendations.push('Collapse repeated memories into stronger canonical entries and clean up duplicate drift regularly.');
  }
  if (lowQualityCount > 0) {
    recommendations.push('Rewrite or filter low-information memories so future analysis has denser evidence to work with.');
  }
  if (relationshipCount < 4) {
    recommendations.push('Capture more explicit collaborator, stakeholder, and project interactions to strengthen relationship signals.');
  }
  if (contradictionsOrTensions.length > 0) {
    recommendations.push('Track important tradeoffs explicitly so future persona summaries can separate stable preferences from situational compromises.');
  }
  if (recommendations.length === 0) {
    recommendations.push('The corpus is already fairly healthy; focus next on richer relationship and decision-rationale capture.');
  }

  return recommendations;
}

function makeDiscoveryId(prefix: string, value: string): string {
  return `${prefix}:${normalizeToken(value).replace(/[^a-z0-9\u4e00-\u9fa5]+/giu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'signal'}`;
}

function uniqueDiscoveryCards(cards: DeepAnalysisDiscoveryCard[], limit = cards.length): DeepAnalysisDiscoveryCard[] {
  const seen = new Set<string>();
  const unique: DeepAnalysisDiscoveryCard[] = [];

  for (const card of cards) {
    if (seen.has(card.id)) {
      continue;
    }
    seen.add(card.id);
    unique.push(card);
    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

function buildDiscoveryCards(input: {
  themeHighlights: DeepAnalysisThemeItem[];
  entities: CorpusSignals['entities'];
  persona: PersonaSummarySection;
  duplicateMemoryCount: number;
  lowQualityExamples: DeepAnalysisQualityIssue[];
  coverageGaps: string[];
  relationships: DeepAnalysisRelationship[];
  recommendations: string[];
}): DeepAnalysisDiscoveryCard[] {
  const cards: DeepAnalysisDiscoveryCard[] = [];
  const topTheme = input.themeHighlights[0];
  const topProject = input.entities.projects[0];
  const topPerson = input.entities.people[0];
  const topRoutine = input.persona.notableRoutines[0];
  const topDecision = input.persona.decisionSignals[0] ?? input.persona.contradictionsOrTensions[0];

  if (topTheme || topProject) {
    const title = topProject
      ? `Focus area: ${topProject.label}`
      : `Focus area: ${topTheme?.name ?? 'core themes'}`;
    const summary = topProject && topTheme
      ? `Project memories around ${topProject.label} repeatedly overlap with ${topTheme.name}, suggesting a sustained workstream rather than isolated notes.`
      : `The corpus keeps returning to ${topTheme?.name ?? topProject?.label}, making it one of the strongest recurring focus areas.`;
    cards.push({
      id: makeDiscoveryId('focus', topProject?.label ?? topTheme?.name ?? 'focus'),
      kind: 'focus_area',
      title,
      summary,
      confidence: 0.78,
      evidenceMemoryIds: [
        ...(topProject?.evidenceMemoryIds ?? []),
        ...(input.entities.people[0]?.evidenceMemoryIds ?? []),
      ].slice(0, 6),
    });
  }

  if (topPerson) {
    const related = input.relationships.find((item) => normalizeToken(item.target) === normalizeToken(topPerson.label));
    cards.push({
      id: makeDiscoveryId('collaborator', topPerson.label),
      kind: 'collaborator',
      title: `Key collaborator: ${topPerson.label}`,
      summary: related
        ? `${topPerson.label} appears as a repeated collaborator with an explicit ${related.relation} signal, which makes this relationship strong enough to operationalize later.`
        : `${topPerson.label} appears across ${topPerson.count} memories, which makes them one of the clearest human anchors in the corpus.`,
      confidence: related ? 0.82 : 0.72,
      evidenceMemoryIds: related
        ? related.evidenceMemoryIds.slice(0, 6)
        : topPerson.evidenceMemoryIds.slice(0, 6),
    });
  }

  if (topRoutine) {
    const evidence = input.persona.evidenceHighlights.find((item) => item.detail === topRoutine);
    cards.push({
      id: makeDiscoveryId('routine', topRoutine),
      kind: 'routine',
      title: 'Stable routine detected',
      summary: topRoutine,
      confidence: 0.74,
      evidenceMemoryIds: evidence?.memoryIds.slice(0, 6) ?? [],
    });
  }

  if (topDecision) {
    const evidence = input.persona.evidenceHighlights.find((item) => item.detail === topDecision)
      ?? input.persona.evidenceHighlights[0];
    cards.push({
      id: makeDiscoveryId('decision', topDecision),
      kind: 'decision',
      title: 'Decision pattern',
      summary: topDecision,
      confidence: 0.7,
      evidenceMemoryIds: evidence?.memoryIds.slice(0, 6) ?? [],
    });
  }

  if (input.duplicateMemoryCount > 0 || input.lowQualityExamples.length > 0) {
    cards.push({
      id: makeDiscoveryId('hygiene', `dup-${input.duplicateMemoryCount}-low-${input.lowQualityExamples.length}`),
      kind: 'hygiene',
      title: 'Memory hygiene opportunity',
      summary: input.duplicateMemoryCount > 0
        ? `${input.duplicateMemoryCount} duplicate memories were detected, so cleanup would immediately improve future analysis density and reduce drift.`
        : `${input.lowQualityExamples.length} low-information memories were detected, so a cleanup pass would improve future synthesis quality.`,
      confidence: 0.9,
      evidenceMemoryIds: input.lowQualityExamples.slice(0, 4).map((item) => item.memoryId),
    });
  }

  if (input.coverageGaps.length > 0) {
    cards.push({
      id: makeDiscoveryId('opportunity', input.coverageGaps[0]!),
      kind: 'opportunity',
      title: 'Coverage opportunity',
      summary: input.coverageGaps[0]!,
      confidence: 0.68,
      evidenceMemoryIds: input.entities.projects[0]?.evidenceMemoryIds.slice(0, 4)
        ?? input.entities.tools[0]?.evidenceMemoryIds.slice(0, 4)
        ?? input.entities.people[0]?.evidenceMemoryIds.slice(0, 4)
        ?? [],
    });
  } else if (input.recommendations[0]) {
    cards.push({
      id: makeDiscoveryId('opportunity', input.recommendations[0]),
      kind: 'opportunity',
      title: 'Next enrichment opportunity',
      summary: input.recommendations[0],
      confidence: 0.66,
      evidenceMemoryIds: input.entities.projects[0]?.evidenceMemoryIds.slice(0, 4)
        ?? input.entities.people[0]?.evidenceMemoryIds.slice(0, 4)
        ?? input.entities.tools[0]?.evidenceMemoryIds.slice(0, 4)
        ?? [],
    });
  }

  return uniqueDiscoveryCards(cards, 6);
}

function buildPreview(report: DeepAnalysisReportDocument): DeepAnalysisReportPreview {
  return {
    generatedAt: trimToString(report.overview?.generatedAt) ?? new Date().toISOString(),
    summary: trimToString(report.persona?.summary) ?? 'Deep analysis report generated.',
    topThemes: (report.themeLandscape?.highlights ?? [])
      .map((item) => trimToString(item?.name))
      .filter((item): item is string => item !== null)
      .slice(0, 3),
    keyRecommendations: coerceStringArray(report.recommendations, 3),
  };
}

function validateMemoryReferences(memoryIds: Set<string>, ids: string[], errorMessage: string): void {
  for (const memoryId of ids) {
    if (!memoryIds.has(memoryId)) {
      throw new AppError(errorMessage, {
        statusCode: 500,
        code: 'DEEP_ANALYSIS_REPORT_INVALID',
      });
    }
  }
}

function validateReport(
  report: DeepAnalysisReportDocument,
  memoryIds: Set<string>,
  totalMemoryCount: number,
  deduplicatedMemoryCount: number,
): void {
  if (report.overview?.memoryCount !== totalMemoryCount) {
    throw new AppError('Report overview count does not match source memory count', {
      statusCode: 500,
      code: 'DEEP_ANALYSIS_REPORT_INVALID',
    });
  }

  if (report.overview?.deduplicatedMemoryCount !== deduplicatedMemoryCount) {
    throw new AppError('Report deduplicated count does not match prepared memory count', {
      statusCode: 500,
      code: 'DEEP_ANALYSIS_REPORT_INVALID',
    });
  }

  const themeNames = (report.themeLandscape?.highlights ?? [])
    .map((item) => normalizeToken(item?.name));
  if (themeNames.some((name) => !name || DISALLOWED_THEME_TERMS.has(name))) {
    throw new AppError('Report theme landscape contains generic or disallowed terms', {
      statusCode: 500,
      code: 'DEEP_ANALYSIS_REPORT_INVALID',
    });
  }

  for (const group of [
    ...(report.entities?.people ?? []),
    ...(report.entities?.teams ?? []),
    ...(report.entities?.projects ?? []),
    ...(report.entities?.tools ?? []),
    ...(report.entities?.places ?? []),
  ]) {
    const label = normalizeToken(group?.label);
    if (!label || DISALLOWED_ENTITY_TERMS.has(label)) {
      throw new AppError('Report entities contain generic or disallowed labels', {
        statusCode: 500,
        code: 'DEEP_ANALYSIS_REPORT_INVALID',
      });
    }
    validateMemoryReferences(
      memoryIds,
      coerceStringArray(group?.evidenceMemoryIds, 12),
      'Report entity evidence references an unknown memory',
    );
  }

  for (const relationship of report.relationships ?? []) {
    if (
      !normalizeToken(relationship?.source) ||
      !normalizeToken(relationship?.relation) ||
      !normalizeToken(relationship?.target)
    ) {
      throw new AppError('Report relationships contain empty fields', {
        statusCode: 500,
        code: 'DEEP_ANALYSIS_REPORT_INVALID',
      });
    }
    validateMemoryReferences(
      memoryIds,
      coerceStringArray(relationship?.evidenceMemoryIds, 12),
      'Report relationship evidence references an unknown memory',
    );
  }

  for (const issue of report.quality?.lowQualityExamples ?? []) {
    const memoryId = trimToString(issue?.memoryId);
    if (!memoryId) {
      throw new AppError('Report low-quality examples contain empty memory ids', {
        statusCode: 500,
        code: 'DEEP_ANALYSIS_REPORT_INVALID',
      });
    }
    validateMemoryReferences(
      memoryIds,
      [memoryId],
      'Report low-quality memory references an unknown memory',
    );
  }

  for (const cluster of report.quality?.duplicateClusters ?? []) {
    const canonicalMemoryId = trimToString(cluster?.canonicalMemoryId);
    if (!canonicalMemoryId) {
      throw new AppError('Report duplicate clusters contain empty canonical ids', {
        statusCode: 500,
        code: 'DEEP_ANALYSIS_REPORT_INVALID',
      });
    }
    validateMemoryReferences(
      memoryIds,
      [canonicalMemoryId, ...coerceStringArray(cluster?.duplicateMemoryIds, 12)],
      'Report duplicate cluster references an unknown memory',
    );
  }

  for (const highlight of report.persona?.evidenceHighlights ?? []) {
    validateMemoryReferences(
      memoryIds,
      coerceStringArray(highlight?.memoryIds, 12),
      'Report persona evidence references an unknown memory',
    );
  }

  for (const discovery of report.discoveries ?? []) {
    validateMemoryReferences(
      memoryIds,
      coerceStringArray(discovery?.evidenceMemoryIds, 12),
      'Report discovery evidence references an unknown memory',
    );
  }

  const personaSignalCount =
    (report.persona?.workingStyle?.length ?? 0) +
    (report.persona?.goals?.length ?? 0) +
    (report.persona?.preferences?.length ?? 0) +
    (report.persona?.constraints?.length ?? 0) +
    (report.persona?.decisionSignals?.length ?? 0) +
    (report.persona?.notableRoutines?.length ?? 0) +
    (report.persona?.evidenceHighlights?.length ?? 0);

  if ((trimToString(report.persona?.summary)?.length ?? 0) < 80 || personaSignalCount < 4) {
    throw new AppError('Report persona section is too shallow', {
      statusCode: 500,
      code: 'DEEP_ANALYSIS_REPORT_INVALID',
    });
  }
}

function createInternalComment(model: string): InternalCommentPayload {
  return {
    version: 1,
    provider: 'qwen',
    model,
    aggregate: {
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    calls: [],
    events: [],
    runtimeErrors: [],
  };
}

function appendInternalEvent(
  internalComment: InternalCommentPayload,
  level: InternalCommentEvent['level'],
  stage: string,
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  internalComment.events.push({
    at: new Date().toISOString(),
    level,
    stage,
    event,
    fields,
  });

  if (internalComment.events.length > INTERNAL_COMMENT_EVENT_LIMIT) {
    internalComment.events.splice(0, internalComment.events.length - INTERNAL_COMMENT_EVENT_LIMIT);
  }
}

function isTrimRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('trim') && message.includes('undefined');
}

function appendRuntimeError(
  internalComment: InternalCommentPayload,
  stage: string,
  error: unknown,
  errorCode: string | null,
): void {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const errorMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? null : null;

  internalComment.runtimeErrors.push({
    at: new Date().toISOString(),
    stage,
    errorName,
    errorCode,
    errorMessage,
    stack: stack?.slice(0, INTERNAL_COMMENT_STACK_LIMIT) ?? null,
    isTrimError: isTrimRuntimeError(error),
  });

  if (internalComment.runtimeErrors.length > INTERNAL_COMMENT_RUNTIME_ERROR_LIMIT) {
    internalComment.runtimeErrors.splice(
      0,
      internalComment.runtimeErrors.length - INTERNAL_COMMENT_RUNTIME_ERROR_LIMIT,
    );
  }
}

function parseInternalComment(
  value: string | null | undefined,
  fallbackModel: string,
): InternalCommentPayload {
  if (!value) {
    return createInternalComment(fallbackModel);
  }

  try {
    const parsed = JSON.parse(value) as Partial<InternalCommentPayload>;
    return {
      version: 1,
      provider: 'qwen',
      model: typeof parsed.model === 'string' && parsed.model.length > 0
        ? parsed.model
        : fallbackModel,
      aggregate: {
        requestCount: Number(parsed.aggregate?.requestCount ?? 0),
        successCount: Number(parsed.aggregate?.successCount ?? 0),
        failureCount: Number(parsed.aggregate?.failureCount ?? 0),
        promptTokens: Number(parsed.aggregate?.promptTokens ?? 0),
        completionTokens: Number(parsed.aggregate?.completionTokens ?? 0),
        totalTokens: Number(parsed.aggregate?.totalTokens ?? 0),
      },
      calls: Array.isArray(parsed.calls) ? parsed.calls as InternalCommentCall[] : [],
      events: Array.isArray(parsed.events) ? parsed.events as InternalCommentEvent[] : [],
      runtimeErrors: Array.isArray(parsed.runtimeErrors)
        ? parsed.runtimeErrors as InternalCommentRuntimeError[]
        : [],
    };
  } catch {
    return createInternalComment(fallbackModel);
  }
}

@Injectable()
export class DeepAnalysisReportProcessorService {
  private readonly logger = new Logger(DeepAnalysisReportProcessorService.name);

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly storage: S3PayloadStorageService,
    private readonly qwen: QwenDeepAnalysisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async process(message: DeepAnalysisReportMessage): Promise<void> {
    const processStartedAt = Date.now();
    const reportRecord = await this.repository.getDeepAnalysisReport(message.reportId);
    const internalComment = parseInternalComment(
      reportRecord.internalComment,
      this.qwen.getConfiguredModel(),
    );
    let chunkSummary: ChunkAnalysisSummary = {
      totalChunks: 0,
      successCount: 0,
      failureCount: 0,
    };
    let currentStage: DeepAnalysisReportStage = DeepAnalysisReportStage.PREPROCESS;

    if (reportRecord.status === DeepAnalysisReportStatus.COMPLETED) {
      return;
    }

    appendInternalEvent(internalComment, 'info', currentStage, 'deep_analysis_process_started', {
      reportId: reportRecord.id,
      status: reportRecord.status,
      lang: reportRecord.lang,
    });
    await this.repository.updateDeepAnalysisReport(reportRecord.id, {
      status: DeepAnalysisReportStatus.PREPARING,
      stage: DeepAnalysisReportStage.PREPROCESS,
      progressPercent: 10,
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
      internalComment: JSON.stringify(internalComment),
    });

    try {
      const payloadBuffer = await this.storage.getObjectBuffer(reportRecord.sourceSnapshotObjectKey);
      const payload = gunzipJson<SourceSnapshotPayload>(payloadBuffer);
      const prepared = this.prepareMemories(payload.memories);
      const totalChunks = this.buildChunkCount(prepared.uniqueMemories.length);
      const chunkConcurrency = this.buildChunkConcurrency(totalChunks);
      currentStage = DeepAnalysisReportStage.CHUNK_ANALYSIS;
      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.ANALYZING,
        stage: DeepAnalysisReportStage.CHUNK_ANALYSIS,
        progressPercent: CHUNK_ANALYSIS_PROGRESS_START,
      });
      appendInternalEvent(internalComment, 'info', currentStage, 'deep_analysis_chunk_analysis_started', {
        reportId: reportRecord.id,
        memoryCount: payload.memories.length,
        deduplicatedMemoryCount: prepared.deduplicatedCount,
        totalChunks,
        concurrency: chunkConcurrency,
        model: this.qwen.getConfiguredModel(),
        thinkingDisabled: true,
      });
      this.logInfo('deep_analysis_chunk_analysis_started', {
        reportId: reportRecord.id,
        memoryCount: payload.memories.length,
        deduplicatedMemoryCount: prepared.deduplicatedCount,
        totalChunks,
        concurrency: chunkConcurrency,
        model: this.qwen.getConfiguredModel(),
        thinkingDisabled: true,
      });
      const chunkOutcome = await this.analyzeChunks(
        reportRecord.id,
        internalComment,
        prepared.uniqueMemories,
      );
      chunkSummary = chunkOutcome.summary;
      const chunkInsights = chunkOutcome.insights;
      const corpusSignals = this.buildCorpusSignals(prepared, chunkInsights);

      currentStage = DeepAnalysisReportStage.GLOBAL_SYNTHESIS;
      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.SYNTHESIZING,
        stage: DeepAnalysisReportStage.GLOBAL_SYNTHESIS,
        progressPercent: 60,
      });
      appendInternalEvent(internalComment, 'info', currentStage, 'deep_analysis_global_synthesis_started', {
        reportId: reportRecord.id,
        totalChunks: chunkSummary.totalChunks,
      });
      this.logInfo('deep_analysis_global_synthesis_started', {
        reportId: reportRecord.id,
        totalChunks: chunkSummary.totalChunks,
      });

      const synthesisOutcome = await this.synthesizeReport(
        reportRecord.id,
        internalComment,
        reportRecord.lang,
        prepared,
        chunkInsights,
        corpusSignals,
      );
      let report = synthesisOutcome.report;
      appendInternalEvent(internalComment, 'info', currentStage, 'deep_analysis_global_synthesis_completed', {
        reportId: reportRecord.id,
        durationMs: synthesisOutcome.durationMs,
        fallbackUsed: synthesisOutcome.fallbackUsed,
        errorCode: synthesisOutcome.errorCode,
      });
      this.logInfo('deep_analysis_global_synthesis_completed', {
        reportId: reportRecord.id,
        durationMs: synthesisOutcome.durationMs,
        fallbackUsed: synthesisOutcome.fallbackUsed,
        errorCode: synthesisOutcome.errorCode,
      });

      currentStage = DeepAnalysisReportStage.VALIDATE;
      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.SYNTHESIZING,
        stage: DeepAnalysisReportStage.VALIDATE,
        progressPercent: 90,
      });

      const memoryIds = new Set(payload.memories.map((memory) => memory.id));

      try {
        validateReport(
          report,
          memoryIds,
          prepared.originalCount,
          prepared.deduplicatedCount,
        );
      } catch (error) {
        appendRuntimeError(internalComment, currentStage, error, 'DEEP_ANALYSIS_REPORT_INVALID');
        appendInternalEvent(internalComment, 'warn', currentStage, 'deep_analysis_validation_failed', {
          reportId: reportRecord.id,
          errorCode: 'DEEP_ANALYSIS_REPORT_INVALID',
          isTrimError: isTrimRuntimeError(error),
        });
        this.logger.warn(`Validation failed for report ${reportRecord.id}; retrying with heuristic synthesis`);
        report = this.buildHeuristicReport(reportRecord.lang, prepared, corpusSignals);
        validateReport(
          report,
          memoryIds,
          prepared.originalCount,
          prepared.deduplicatedCount,
        );
      }

      const reportObjectKey = `deep-analysis/reports/${reportRecord.id}/report.json`;
      await this.storage.putJson(reportObjectKey, report);
      currentStage = DeepAnalysisReportStage.COMPLETE;
      appendInternalEvent(internalComment, 'info', currentStage, 'deep_analysis_report_completed', {
        reportId: reportRecord.id,
        totalDurationMs: Date.now() - processStartedAt,
        totalChunks: chunkSummary.totalChunks,
        chunkSuccessCount: chunkSummary.successCount,
        chunkFailureCount: chunkSummary.failureCount,
      });
      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.COMPLETED,
        stage: DeepAnalysisReportStage.COMPLETE,
        progressPercent: 100,
        completedAt: new Date(),
        reportObjectKey,
        previewJson: buildPreview(report) as unknown as Prisma.InputJsonValue,
        internalComment: JSON.stringify(internalComment),
      });
      this.logInfo('deep_analysis_report_completed', {
        reportId: reportRecord.id,
        totalDurationMs: Date.now() - processStartedAt,
        totalChunks: chunkSummary.totalChunks,
        chunkSuccessCount: chunkSummary.successCount,
        chunkFailureCount: chunkSummary.failureCount,
      });
    } catch (error) {
      const errorCode = error instanceof AppError ? error.code : 'DEEP_ANALYSIS_PROCESSING_FAILED';
      appendRuntimeError(internalComment, currentStage, error, errorCode);
      appendInternalEvent(internalComment, 'error', currentStage, 'deep_analysis_report_failed', {
        reportId: reportRecord.id,
        totalDurationMs: Date.now() - processStartedAt,
        totalChunks: chunkSummary.totalChunks,
        chunkSuccessCount: chunkSummary.successCount,
        chunkFailureCount: chunkSummary.failureCount,
        errorCode,
        isTrimError: isTrimRuntimeError(error),
      });
      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.FAILED,
        stage: DeepAnalysisReportStage.VALIDATE,
        progressPercent: 100,
        completedAt: new Date(),
        errorCode,
        errorMessage: error instanceof Error ? error.message.slice(0, 512) : 'Deep analysis failed',
        internalComment: JSON.stringify(internalComment),
      });
      this.logger.error(
        JSON.stringify({
          event: 'deep_analysis_report_failed',
          reportId: reportRecord.id,
          totalDurationMs: Date.now() - processStartedAt,
          totalChunks: chunkSummary.totalChunks,
          chunkSuccessCount: chunkSummary.successCount,
          chunkFailureCount: chunkSummary.failureCount,
          errorCode,
        }),
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private prepareMemories(memories: DeepAnalysisMemorySnapshot[]): PreparedCorpus {
    const groupedByHash = new Map<string, PreparedMemory[]>();

    for (const memory of memories) {
      const normalized = normalizeMemory({
        id: memory.id,
        content: memory.content,
        createdAt: memory.createdAt,
        metadata: memory.metadata ?? {},
      });

      const preparedMemory: PreparedMemory = {
        id: normalized.id,
        content: normalized.content,
        contentHash: normalized.contentHash,
        createdAt: normalized.createdAt,
        tags: Array.isArray(memory.tags) ? memory.tags : [],
      };
      const current = groupedByHash.get(normalized.contentHash) ?? [];
      current.push(preparedMemory);
      groupedByHash.set(normalized.contentHash, current);
    }

    const uniqueMemories: PreparedMemory[] = [];
    const duplicateClusters = [...groupedByHash.values()]
      .map((group) => group.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()))
      .sort((left, right) => left[0]!.createdAt.getTime() - right[0]!.createdAt.getTime())
      .flatMap((group) => {
        uniqueMemories.push(group[0]!);

        if (group.length < 2) {
          return [];
        }

        return [{
          canonicalMemoryId: group[0]!.id,
          duplicateMemoryIds: group.slice(1).map((memory) => memory.id),
        }];
      })
      .sort((left, right) => right.duplicateMemoryIds.length - left.duplicateMemoryIds.length)
      .slice(0, 10);

    return {
      originalCount: memories.length,
      deduplicatedCount: uniqueMemories.length,
      uniqueMemories,
      duplicateClusters,
    };
  }

  private async analyzeChunks(
    reportId: string,
    internalComment: InternalCommentPayload,
    memories: PreparedMemory[],
  ): Promise<ChunkAnalysisOutcome> {
    const chunks = chunkArray(memories, CHUNK_SIZE);

    if (chunks.length === 0) {
      return {
        insights: [],
        summary: {
          totalChunks: 0,
          successCount: 0,
          failureCount: 0,
        },
      };
    }

    const insights = new Array<ChunkInsight>(chunks.length);
    const concurrency = this.buildChunkConcurrency(chunks.length);
    let nextChunkIndex = 0;
    let completedChunkCount = 0;
    let successCount = 0;
    let failureCount = 0;
    let commitChain = Promise.resolve();

    const commitChunkResult = (execution: ChunkExecutionResult): Promise<void> => {
      commitChain = commitChain.then(async () => {
        insights[execution.index] = execution.insight;
        this.appendModelCall(
          internalComment,
          execution.index + 1,
          execution.result,
        );
        if (execution.result.requestMeta.success) {
          successCount += 1;
        } else {
          failureCount += 1;
        }
        completedChunkCount += 1;
        const progressPercent = this.buildChunkAnalysisProgress(completedChunkCount, chunks.length);
        appendInternalEvent(internalComment, 'info', DeepAnalysisReportStage.CHUNK_ANALYSIS, 'deep_analysis_chunk_completed', {
          reportId,
          chunkIndex: execution.index + 1,
          totalChunks: chunks.length,
          chunkSize: execution.chunkSize,
          durationMs: execution.durationMs,
          fallbackUsed: execution.fallbackUsed,
          errorCode: execution.result.requestMeta.errorCode,
          progressPercent,
        });
        await this.repository.updateDeepAnalysisReport(reportId, {
          progressPercent,
          internalComment: JSON.stringify(internalComment),
        });
        this.logInfo('deep_analysis_chunk_completed', {
          reportId,
          chunkIndex: execution.index + 1,
          totalChunks: chunks.length,
          chunkSize: execution.chunkSize,
          durationMs: execution.durationMs,
          fallbackUsed: execution.fallbackUsed,
          errorCode: execution.result.requestMeta.errorCode,
          progressPercent,
        });
      });

      return commitChain;
    };

    const runChunk = async (index: number, chunk: PreparedMemory[]): Promise<void> => {
      appendInternalEvent(internalComment, 'info', DeepAnalysisReportStage.CHUNK_ANALYSIS, 'deep_analysis_chunk_started', {
        reportId,
        chunkIndex: index + 1,
        totalChunks: chunks.length,
        chunkSize: chunk.length,
      });
      this.logInfo('deep_analysis_chunk_started', {
        reportId,
        chunkIndex: index + 1,
        totalChunks: chunks.length,
        chunkSize: chunk.length,
      });
      const chunkStartedAt = Date.now();
      const qwenInsight = await this.qwen.createJson<ChunkInsight>(
        'chunk_analysis',
        [
          'You analyze one chunk of user memories and return JSON only.',
          'Never emit stopwords or generic role terms like the, and, for, user, agent, assistant, self, team, project, task, system, memory, workflow.',
          'Themes must be high-information phrases or specific concepts, not filler words.',
          'Entities must be specific people, teams, projects, tools, or places with stable evidence.',
          'Persona signals must summarize repeated behavior patterns across the chunk, not restate one memory.',
          'Return an object with keys: summary, themes, entities, personaSignals, relationships.',
        ].join(' '),
        JSON.stringify({
          memories: chunk.map((memory) => ({
            id: memory.id,
            content: sentencePreview(memory.content),
            tags: memory.tags.slice(0, 6),
          })),
        }),
      );
      const durationMs = Date.now() - chunkStartedAt;
      const fallbackUsed = qwenInsight.parsed === null;
      const insight = qwenInsight.parsed
        ? sanitizeChunkInsight(qwenInsight.parsed)
        : this.buildHeuristicChunkInsight(chunk);

      await commitChunkResult({
        index,
        chunkSize: chunk.length,
        durationMs,
        fallbackUsed,
        result: qwenInsight,
        insight,
      });
    };

    const workers = Array.from({ length: concurrency }, async () => {
      while (nextChunkIndex < chunks.length) {
        const currentIndex = nextChunkIndex;
        nextChunkIndex += 1;
        await runChunk(currentIndex, chunks[currentIndex]!);
      }
    });

    await Promise.all(workers);
    await commitChain;

    return {
      insights,
      summary: {
        totalChunks: chunks.length,
        successCount,
        failureCount,
      },
    };
  }

  private buildChunkAnalysisProgress(processedChunks: number, totalChunks: number): number {
    if (totalChunks <= 0) {
      return CHUNK_ANALYSIS_PROGRESS_START;
    }

    const spread = CHUNK_ANALYSIS_PROGRESS_END - CHUNK_ANALYSIS_PROGRESS_START;
    return Math.min(
      CHUNK_ANALYSIS_PROGRESS_END,
      CHUNK_ANALYSIS_PROGRESS_START + Math.floor((processedChunks / totalChunks) * spread),
    );
  }

  private buildChunkCount(memoryCount: number): number {
    if (memoryCount <= 0) {
      return 0;
    }

    return Math.ceil(memoryCount / CHUNK_SIZE);
  }

  private buildChunkConcurrency(totalChunks: number): number {
    if (totalChunks <= 0) {
      return 0;
    }

    return Math.min(this.config.analysis.deepAnalysisChunkConcurrency, totalChunks);
  }

  private buildHeuristicChunkInsight(memories: PreparedMemory[]): ChunkInsight {
    const stats = this.collectCorpusStats(memories);
    const themeNames = this.buildThemeHighlights(stats.tokenCounts, stats.phraseCounts).map((item) => ({
      name: item.name,
      memoryIds: [],
    }));

    return {
      summary: this.buildPersonaSection(themeNames.map((item) => item.name), stats).summary,
      themes: themeNames,
      entities: {
        people: buildEntityGroups(stats.personCounters, 5).map((item) => item.label),
        teams: buildEntityGroups(stats.teamCounters, 5).map((item) => item.label),
        projects: buildEntityGroups(stats.projectCounters, 5).map((item) => item.label),
        tools: buildEntityGroups(stats.toolCounters, 5).map((item) => item.label),
        places: buildEntityGroups(stats.placeCounters, 5).map((item) => item.label),
      },
      personaSignals: {
        workingStyle: collectRepresentativeSignals(stats.workingStyleSignals, 4),
        goals: collectRepresentativeSignals(stats.goalSignals, 4),
        preferences: collectRepresentativeSignals(stats.preferenceSignals, 4),
        constraints: collectRepresentativeSignals(stats.constraintSignals, 4),
        decisionSignals: collectRepresentativeSignals(stats.decisionSignals, 4),
        notableRoutines: collectRepresentativeSignals(stats.routineSignals, 4),
        contradictionsOrTensions: buildContradictions(stats),
      },
      relationships: stats.relationships.slice(0, 10),
    };
  }

  private collectCorpusStats(memories: PreparedMemory[]): CorpusStats {
    const stats: CorpusStats = {
      tokenCounts: new Map<string, number>(),
      phraseCounts: new Map<string, number>(),
      personCounters: new Map<string, CounterValue>(),
      teamCounters: new Map<string, CounterValue>(),
      projectCounters: new Map<string, CounterValue>(),
      toolCounters: new Map<string, CounterValue>(),
      placeCounters: new Map<string, CounterValue>(),
      workingStyleSignals: [],
      goalSignals: [],
      preferenceSignals: [],
      constraintSignals: [],
      decisionSignals: [],
      routineSignals: [],
      lowQualityExamples: [],
      relationships: [],
    };

    for (const memory of memories) {
      const preview = sentencePreview(memory.content);
      const lower = normalizeToken(memory.content);
      const uniqueTokens = new Set(tokenize(memory.content));
      const uniquePhrases = new Set(collectMemoryPhrases(memory.content));

      for (const token of uniqueTokens) {
        stats.tokenCounts.set(token, (stats.tokenCounts.get(token) ?? 0) + 1);
      }

      for (const phrase of uniquePhrases) {
        stats.phraseCounts.set(phrase, (stats.phraseCounts.get(phrase) ?? 0) + 1);
      }

      for (const name of extractProperNames(memory.content)) {
        upsertCounter(stats.personCounters, name, memory.id);
      }

      for (const teamLabel of extractTeamLabels(memory.content)) {
        upsertCounter(stats.teamCounters, teamLabel, memory.id);
      }

      for (const hint of TOOL_HINTS) {
        if (lower.includes(hint)) {
          upsertCounter(stats.toolCounters, hint, memory.id);
        }
      }

      for (const hint of PLACE_HINTS) {
        if (lower.includes(hint)) {
          upsertCounter(stats.placeCounters, hint, memory.id);
        }
      }

      for (const tag of memory.tags) {
        const normalizedTag = normalizeToken(tag.replace(/^#+/u, ''));
        if (
          isMeaningfulToken(normalizedTag) &&
          !DISALLOWED_PROJECT_TAGS.has(normalizedTag) &&
          !DISALLOWED_ENTITY_TERMS.has(normalizedTag)
        ) {
          upsertCounter(stats.projectCounters, normalizedTag, memory.id);
        }
      }

      if (/(prefer|prefers|like|likes|favorite|偏好|喜欢|更喜欢|倾向于)/iu.test(memory.content)) {
        appendSignal(stats.preferenceSignals, preview, memory.id);
      }
      if (/(debug|refactor|review|document|structured|structure|automation|automate|iterate|迭代|自动化|结构化|细节|详细|简洁|token|workflow|memory insight)/iu.test(memory.content)) {
        appendSignal(stats.workingStyleSignals, preview, memory.id);
      }
      if (/(goal|plan to|target|roadmap|objective|目标|计划|路线图|想要)/iu.test(memory.content)) {
        appendSignal(stats.goalSignals, preview, memory.id);
      }
      if (/(must|need to|should not|cannot|can't|avoid|禁止|不要|约束|限制|必须|不能|避免)/iu.test(memory.content)) {
        appendSignal(stats.constraintSignals, preview, memory.id);
      }
      if (/(decide|decision|choose|selected|tradeoff|priority|prioritize|consider|决定|选择|取舍|优先级|权衡|考虑)/iu.test(memory.content)) {
        appendSignal(stats.decisionSignals, preview, memory.id);
      }
      if (/(daily|weekly|every day|every morning|usually|routine|habit|每天|每周|经常|习惯|工作时间)/iu.test(memory.content)) {
        appendSignal(stats.routineSignals, preview, memory.id);
      }

      if (memory.content.trim().length < 24 || ACKNOWLEDGEMENT_PATTERN.test(lower)) {
        stats.lowQualityExamples.push({
          memoryId: memory.id,
          reason: 'Very short or low-information memory',
        });
      }

      for (const pattern of RELATION_PATTERNS) {
        for (const match of memory.content.matchAll(pattern.pattern)) {
          const target = match[1]?.trim();

          if (!target || !isMeaningfulEntityLabel(target)) {
            continue;
          }

          stats.relationships.push({
            source: 'user',
            relation: pattern.relation,
            target,
            confidence: 0.58,
            evidenceMemoryIds: [memory.id],
            evidenceExcerpts: [preview],
          });
        }
      }
    }

    return stats;
  }

  private buildThemeHighlights(
    tokenCounts: Map<string, number>,
    phraseCounts: Map<string, number>,
  ): DeepAnalysisThemeItem[] {
    const highlights: DeepAnalysisThemeItem[] = [];
    const seen = new Set<string>();

    for (const [name, count] of pickTopEntries(phraseCounts, 10)) {
      if (count < 2 || seen.has(name) || DISALLOWED_THEME_TERMS.has(name)) {
        continue;
      }
      seen.add(name);
      highlights.push({
        name,
        count,
        description: `Recurring phrase found in ${count} memories.`,
      });
      if (highlights.length >= 8) {
        return highlights;
      }
    }

    for (const [name, count] of pickTopEntries(tokenCounts, 12)) {
      if (count < 2 || seen.has(name) || DISALLOWED_THEME_TERMS.has(name)) {
        continue;
      }
      seen.add(name);
      highlights.push({
        name,
        count,
        description: `Recurring signal across ${count} memories.`,
      });
      if (highlights.length >= 8) {
        break;
      }
    }

    return highlights;
  }

  private buildPersonaSection(themeNames: string[], stats: CorpusStats): PersonaSummarySection {
    const workingStyle = collectRepresentativeSignals(stats.workingStyleSignals, 5);
    const goals = collectRepresentativeSignals(stats.goalSignals, 5);
    const preferences = collectRepresentativeSignals(stats.preferenceSignals, 5);
    const constraints = collectRepresentativeSignals(stats.constraintSignals, 5);
    const decisionSignals = collectRepresentativeSignals(stats.decisionSignals, 5);
    const notableRoutines = collectRepresentativeSignals(stats.routineSignals, 5);
    const contradictionsOrTensions = buildContradictions(stats);
    const evidenceHighlights = buildEvidenceHighlights([
      ...stats.preferenceSignals,
      ...stats.workingStyleSignals,
      ...stats.goalSignals,
      ...stats.constraintSignals,
    ], 4);
    const summaryParts: string[] = [];

    if (themeNames.length > 0) {
      summaryParts.push(
        `This corpus concentrates on ${themeNames.slice(0, 3).join(', ')}, with repeated memory traffic around those domains.`,
      );
    }
    if (workingStyle.length > 0 || preferences.length > 0) {
      summaryParts.push(
        'The user tends to capture working norms, tool choices, and preferred execution patterns rather than isolated facts.',
      );
    }
    if (goals.length > 0 || decisionSignals.length > 0) {
      summaryParts.push(
        'The memories also expose explicit goals and tradeoff decisions, which makes the persona more operational than purely descriptive.',
      );
    }
    if (notableRoutines.length > 0) {
      summaryParts.push(
        'Stable routines and recurring timing references suggest habits that are strong enough to influence future memory insight features.',
      );
    }

    return {
      summary: summaryParts.length > 0
        ? summaryParts.join(' ')
        : 'The corpus contains repeated operational memories, but the current evidence is still too sparse to form a sharper persona summary.',
      workingStyle,
      goals,
      preferences,
      constraints,
      decisionSignals,
      notableRoutines,
      contradictionsOrTensions,
      evidenceHighlights,
    };
  }

  private buildCorpusSignals(
    corpus: PreparedCorpus,
    chunkInsights: ChunkInsight[],
  ): CorpusSignals {
    const stats = this.collectCorpusStats(corpus.uniqueMemories);
    const themeHighlights = this.buildThemeHighlights(stats.tokenCounts, stats.phraseCounts);
    const chunkThemeBoosts = new Map<string, number>();

    for (const chunk of chunkInsights) {
      for (const theme of chunk.themes ?? []) {
        const normalized = normalizeToken(theme.name);
        if (!normalized || DISALLOWED_THEME_TERMS.has(normalized)) {
          continue;
        }
        chunkThemeBoosts.set(normalized, (chunkThemeBoosts.get(normalized) ?? 0) + (theme.memoryIds?.length || 1));
      }
    }

    const boostedHighlights = [
      ...themeHighlights,
      ...pickTopEntries(chunkThemeBoosts, 6)
        .filter(([name]) => !themeHighlights.some((item) => item.name === name))
        .map(([name, count]) => ({
          name,
          count,
          description: `Cross-chunk recurring signal seen in ${count} memory references.`,
        })),
    ].slice(0, 8);

    const relationships = [...stats.relationships, ...chunkInsights.flatMap((item) => item.relationships ?? [])]
      .filter((item, index, list) =>
        list.findIndex((candidate) =>
          candidate.source === item.source &&
          candidate.relation === item.relation &&
          candidate.target === item.target &&
          candidate.evidenceMemoryIds.join('|') === item.evidenceMemoryIds.join('|')) === index)
      .slice(0, 18);
    const persona = this.buildPersonaSection(
      boostedHighlights.map((item) => item.name),
      stats,
    );
    const duplicateMemoryCount = corpus.duplicateClusters.reduce(
      (sum, item) => sum + item.duplicateMemoryIds.length,
      0,
    );
    const coverageGaps = buildCoverageGaps(
      stats.personCounters.size,
      stats.projectCounters.size,
      stats.toolCounters.size,
      stats.routineSignals.length,
      stats.decisionSignals.length,
    );
    const recommendations = buildRecommendations(
      duplicateMemoryCount,
      stats.lowQualityExamples.length,
      relationships.length,
      persona.contradictionsOrTensions,
    );
    const entities = {
      people: buildEntityGroups(stats.personCounters),
      teams: buildEntityGroups(stats.teamCounters),
      projects: buildEntityGroups(stats.projectCounters),
      tools: buildEntityGroups(stats.toolCounters),
      places: buildEntityGroups(stats.placeCounters),
    };
    const discoveries = buildDiscoveryCards({
      themeHighlights: boostedHighlights,
      entities,
      persona,
      duplicateMemoryCount,
      lowQualityExamples: stats.lowQualityExamples.slice(0, 10),
      coverageGaps,
      relationships,
      recommendations,
    });
    const candidateNodes: DeepAnalysisCandidateNode[] = [
      ...boostedHighlights.slice(0, 4).map((item) => ({
        label: item.name,
        kind: 'theme',
        count: item.count,
      })),
      ...buildEntityGroups(stats.personCounters, 2).map((item) => ({
        label: item.label,
        kind: 'person',
        count: item.count,
      })),
      ...buildEntityGroups(stats.projectCounters, 2).map((item) => ({
        label: item.label,
        kind: 'project',
        count: item.count,
      })),
    ].slice(0, 8);
    const candidateEdges: DeepAnalysisCandidateEdge[] = relationships.slice(0, 10).map((item) => ({
      source: item.source,
      relation: item.relation,
      target: item.target,
      confidence: item.confidence,
    }));

    return {
      persona,
      themeHighlights: boostedHighlights,
      entities,
      relationships,
      lowQualityExamples: stats.lowQualityExamples.slice(0, 10),
      duplicateMemoryCount,
      coverageGaps,
      discoveries,
      recommendations,
      productSignals: {
        candidateNodes,
        candidateEdges,
        searchSeeds: uniqueStrings([
          ...boostedHighlights.slice(0, 6).map((item) => item.name),
          ...buildEntityGroups(stats.projectCounters, 4).map((item) => item.label),
          ...buildEntityGroups(stats.personCounters, 4).map((item) => item.label),
        ], 8),
      },
    };
  }

  private async synthesizeReport(
    reportId: string,
    internalComment: InternalCommentPayload,
    lang: string,
    corpus: PreparedCorpus,
    chunkInsights: ChunkInsight[],
    corpusSignals: CorpusSignals,
  ): Promise<SynthesisOutcome> {
    const synthesisStartedAt = Date.now();
    const qwenReport = await this.qwen.createJson<DeepAnalysisReportDocument>(
      'global_synthesis',
      [
        'You synthesize a deep memory analysis report and must return JSON only.',
        'Preserve the exact top-level keys: overview, persona, themeLandscape, entities, relationships, discoveries, quality, recommendations, productSignals.',
        'Do not output stopwords or generic terms such as the, and, for, user, agent, assistant, self, team, project, task, system, memory, workflow.',
        'Persona.summary must be 2-4 strong sentences describing sustained behavior, priorities, and routines across the corpus.',
        'Persona fields must summarize stable patterns using evidence-based statements, not one-off facts.',
        'Every relationship, discovery, and persona evidence item must include valid memoryIds that appear in the provided inputs.',
        'Theme landscape should prefer specific phrases over generic single words.',
        'Discovery cards should call out the most operationally useful findings: focus areas, collaborators, routines, decision patterns, hygiene issues, and enrichment opportunities.',
      ].join(' '),
      JSON.stringify({
        lang,
        overview: {
          memoryCount: corpus.originalCount,
          deduplicatedMemoryCount: corpus.deduplicatedCount,
        },
        chunkInsights,
        corpusSignals,
      }),
    );
    this.appendModelCall(internalComment, 1, qwenReport);
    await this.repository.updateDeepAnalysisReport(reportId, {
      internalComment: JSON.stringify(internalComment),
    });
    const durationMs = Date.now() - synthesisStartedAt;

    if (qwenReport.parsed) {
      return {
        report: qwenReport.parsed,
        durationMs,
        fallbackUsed: false,
        errorCode: null,
      };
    }

    return {
      report: this.buildHeuristicReport(lang, corpus, corpusSignals),
      durationMs,
      fallbackUsed: true,
      errorCode: qwenReport.requestMeta.errorCode,
    };
  }

  private appendModelCall(
    internalComment: InternalCommentPayload,
    index: number,
    result: QwenJsonResult<unknown>,
  ): void {
    if (!result.requestMeta.requested) {
      return;
    }

    const promptTokens = result.usage?.promptTokens ?? null;
    const completionTokens = result.usage?.completionTokens ?? null;
    const totalTokens = result.usage?.totalTokens ?? null;

    internalComment.model = result.usage?.model ?? internalComment.model;
    internalComment.aggregate.requestCount += 1;
    if (result.requestMeta.success) {
      internalComment.aggregate.successCount += 1;
    } else {
      internalComment.aggregate.failureCount += 1;
    }
    internalComment.aggregate.promptTokens += promptTokens ?? 0;
    internalComment.aggregate.completionTokens += completionTokens ?? 0;
    internalComment.aggregate.totalTokens += totalTokens ?? 0;
    internalComment.calls.push({
      stage: result.requestMeta.stage,
      index,
      success: result.requestMeta.success,
      httpStatus: result.requestMeta.httpStatus,
      parseSucceeded: result.requestMeta.parseSucceeded,
      promptTokens,
      completionTokens,
      totalTokens,
      usageMissing: result.usage?.usageMissing ?? true,
      requestedAt: result.requestMeta.requestedAt,
      finishedAt: result.requestMeta.finishedAt,
      errorCode: result.requestMeta.errorCode,
      errorMessage: result.requestMeta.errorMessage,
    });
    internalComment.calls.sort((left, right) =>
      INTERNAL_COMMENT_STAGE_ORDER[left.stage] - INTERNAL_COMMENT_STAGE_ORDER[right.stage] ||
      left.index - right.index ||
      left.requestedAt.localeCompare(right.requestedAt));
  }

  private logInfo(
    event: string,
    fields: Record<string, string | number | boolean | null>,
  ): void {
    this.logger.log(JSON.stringify({
      event,
      ...fields,
    }));
  }

  private buildHeuristicReport(
    lang: string,
    corpus: PreparedCorpus,
    corpusSignals: CorpusSignals,
  ): DeepAnalysisReportDocument {
    const memories = corpus.uniqueMemories;
    const generatedAt = new Date().toISOString();

    return {
      overview: {
        memoryCount: corpus.originalCount,
        deduplicatedMemoryCount: corpus.deduplicatedCount,
        generatedAt,
        lang,
        timeSpan: {
          start: memories[0]?.createdAt.toISOString() ?? null,
          end: memories[memories.length - 1]?.createdAt.toISOString() ?? null,
        },
      },
      persona: corpusSignals.persona,
      themeLandscape: {
        highlights: corpusSignals.themeHighlights,
      },
      entities: corpusSignals.entities,
      relationships: corpusSignals.relationships,
      discoveries: corpusSignals.discoveries,
      quality: {
        duplicateRatio: corpus.originalCount === 0
          ? 0
          : Number((corpusSignals.duplicateMemoryCount / corpus.originalCount).toFixed(2)),
        duplicateMemoryCount: corpusSignals.duplicateMemoryCount,
        noisyMemoryCount: corpusSignals.lowQualityExamples.length,
        duplicateClusters: corpus.duplicateClusters,
        lowQualityExamples: corpusSignals.lowQualityExamples,
        coverageGaps: corpusSignals.coverageGaps,
      },
      recommendations: corpusSignals.recommendations,
      productSignals: corpusSignals.productSignals,
    };
  }
}
