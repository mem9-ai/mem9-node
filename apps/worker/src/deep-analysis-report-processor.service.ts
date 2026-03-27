import type {
  DeepAnalysisCandidateEdge,
  DeepAnalysisCandidateNode,
  DeepAnalysisEntityGroup,
  DeepAnalysisMemorySnapshot,
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
import { Injectable, Logger } from '@nestjs/common';
import { DeepAnalysisReportStage, DeepAnalysisReportStatus, Prisma } from '@prisma/client';

import { QwenDeepAnalysisService } from './qwen-deep-analysis.service';

interface SourceSnapshotPayload {
  fetchedAt: string;
  memoryCount: number;
  memories: DeepAnalysisMemorySnapshot[];
}

interface ChunkInsight {
  themes: string[];
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

const TOOL_HINTS = [
  'react', 'typescript', 'javascript', 'node', 'go', 'python', 'docker', 'kubernetes',
  'tidb', 'mysql', 'redis', 'neovim', 'vscode', 'github', 'gitlab', 'openai', 'qwen',
  'claude', 'terraform', 'prometheus',
] as const;
const PLACE_HINTS = ['shanghai', 'beijing', 'singapore', 'tokyo', 'office', 'home'] as const;
const TEAM_HINTS = ['team', 'group', 'platform', 'infra', 'backend', 'frontend', 'security'] as const;
const RELATION_PATTERNS = [
  { pattern: /\bworks with ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g, relation: 'works_with' },
  { pattern: /\bwith ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g, relation: 'interacts_with' },
];

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sentencePreview(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[^\p{L}\p{N}@#._-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function pickTopEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'en'))
    .slice(0, limit);
}

function buildEntityGroups(
  counters: Map<string, { count: number; evidenceMemoryIds: string[] }>,
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

function upsertCounter(
  map: Map<string, { count: number; evidenceMemoryIds: string[] }>,
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

function extractProperNames(content: string): string[] {
  const matches = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) ?? [];
  return [...new Set(matches)].slice(0, 6);
}

function buildPreview(report: DeepAnalysisReportDocument): DeepAnalysisReportPreview {
  return {
    generatedAt: report.overview.generatedAt,
    summary: report.persona.summary,
    topThemes: report.themeLandscape.highlights.slice(0, 3).map((item) => item.name),
    keyRecommendations: report.recommendations.slice(0, 3),
  };
}

function validateReport(
  report: DeepAnalysisReportDocument,
  memoryIds: Set<string>,
  totalMemoryCount: number,
  deduplicatedMemoryCount: number,
): void {
  if (report.overview.memoryCount !== totalMemoryCount) {
    throw new AppError('Report overview count does not match source memory count', {
      statusCode: 500,
      code: 'DEEP_ANALYSIS_REPORT_INVALID',
    });
  }

  if (report.overview.deduplicatedMemoryCount !== deduplicatedMemoryCount) {
    throw new AppError('Report deduplicated count does not match prepared memory count', {
      statusCode: 500,
      code: 'DEEP_ANALYSIS_REPORT_INVALID',
    });
  }

  for (const relationship of report.relationships) {
    for (const memoryId of relationship.evidenceMemoryIds) {
      if (!memoryIds.has(memoryId)) {
        throw new AppError('Report relationship evidence references an unknown memory', {
          statusCode: 500,
          code: 'DEEP_ANALYSIS_REPORT_INVALID',
        });
      }
    }
  }
}

@Injectable()
export class DeepAnalysisReportProcessorService {
  private readonly logger = new Logger(DeepAnalysisReportProcessorService.name);

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly storage: S3PayloadStorageService,
    private readonly qwen: QwenDeepAnalysisService,
  ) {}

  public async process(message: DeepAnalysisReportMessage): Promise<void> {
    const reportRecord = await this.repository.getDeepAnalysisReport(message.reportId);

    if (reportRecord.status === DeepAnalysisReportStatus.COMPLETED) {
      return;
    }

    await this.repository.updateDeepAnalysisReport(reportRecord.id, {
      status: DeepAnalysisReportStatus.PREPARING,
      stage: DeepAnalysisReportStage.PREPROCESS,
      progressPercent: 10,
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
    });

    try {
      const payloadBuffer = await this.storage.getObjectBuffer(reportRecord.sourceSnapshotObjectKey);
      const payload = gunzipJson<SourceSnapshotPayload>(payloadBuffer);
      const prepared = this.prepareMemories(payload.memories);
      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.ANALYZING,
        stage: DeepAnalysisReportStage.CHUNK_ANALYSIS,
        progressPercent: 35,
      });
      const chunkInsights = await this.analyzeChunks(prepared.uniqueMemories);

      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.SYNTHESIZING,
        stage: DeepAnalysisReportStage.GLOBAL_SYNTHESIS,
        progressPercent: 60,
      });

      let report = await this.synthesizeReport(
        reportRecord.lang,
        prepared,
        chunkInsights,
      );

      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.SYNTHESIZING,
        stage: DeepAnalysisReportStage.VALIDATE,
        progressPercent: 90,
      });

      const memoryIds = new Set(prepared.uniqueMemories.map((memory) => memory.id));

      try {
        validateReport(
          report,
          memoryIds,
          prepared.originalCount,
          prepared.deduplicatedCount,
        );
      } catch (error) {
        this.logger.warn(`Validation failed for report ${reportRecord.id}; retrying with heuristic synthesis`);
        report = this.buildHeuristicReport(reportRecord.lang, prepared, chunkInsights);
        validateReport(
          report,
          memoryIds,
          prepared.originalCount,
          prepared.deduplicatedCount,
        );
      }

      const reportObjectKey = `deep-analysis/reports/${reportRecord.id}/report.json`;
      await this.storage.putJson(reportObjectKey, report);
      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.COMPLETED,
        stage: DeepAnalysisReportStage.COMPLETE,
        progressPercent: 100,
        completedAt: new Date(),
        reportObjectKey,
        previewJson: buildPreview(report) as unknown as Prisma.InputJsonValue,
      });
    } catch (error) {
      await this.repository.updateDeepAnalysisReport(reportRecord.id, {
        status: DeepAnalysisReportStatus.FAILED,
        stage: DeepAnalysisReportStage.VALIDATE,
        progressPercent: 100,
        completedAt: new Date(),
        errorCode: error instanceof AppError ? error.code : 'DEEP_ANALYSIS_PROCESSING_FAILED',
        errorMessage: error instanceof Error ? error.message.slice(0, 512) : 'Deep analysis failed',
      });
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

  private async analyzeChunks(memories: PreparedMemory[]): Promise<ChunkInsight[]> {
    const chunks = chunkArray(memories, 250);
    const insights: ChunkInsight[] = [];

    for (const chunk of chunks) {
      const qwenInsight = await this.qwen.createJson<ChunkInsight>(
        'You analyze user memory chunks and return concise JSON with themes and relationships.',
        JSON.stringify({
          memories: chunk.map((memory) => ({
            id: memory.id,
            content: sentencePreview(memory.content),
          })),
        }),
      );

      if (qwenInsight) {
        insights.push(qwenInsight);
        continue;
      }

      insights.push(this.buildHeuristicChunkInsight(chunk));
    }

    return insights;
  }

  private buildHeuristicChunkInsight(memories: PreparedMemory[]): ChunkInsight {
    const tokenCounts = new Map<string, number>();
    const relationships: DeepAnalysisRelationship[] = [];

    for (const memory of memories) {
      for (const token of tokenize(memory.content)) {
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }

      for (const pattern of RELATION_PATTERNS) {
        for (const match of memory.content.matchAll(pattern.pattern)) {
          const target = match[1]?.trim();

          if (!target) {
            continue;
          }

          relationships.push({
            source: 'user',
            relation: pattern.relation,
            target,
            confidence: 0.52,
            evidenceMemoryIds: [memory.id],
            evidenceExcerpts: [sentencePreview(memory.content)],
          });
        }
      }
    }

    return {
      themes: pickTopEntries(tokenCounts, 6).map(([token]) => token),
      relationships,
    };
  }

  private async synthesizeReport(
    lang: string,
    corpus: PreparedCorpus,
    chunkInsights: ChunkInsight[],
  ): Promise<DeepAnalysisReportDocument> {
    const qwenReport = await this.qwen.createJson<DeepAnalysisReportDocument>(
      'You synthesize a deep memory analysis report and must return JSON only.',
      JSON.stringify({
        lang,
        memoryCount: corpus.originalCount,
        deduplicatedMemoryCount: corpus.deduplicatedCount,
        chunkInsights,
      }),
    );

    if (qwenReport) {
      return qwenReport;
    }

    return this.buildHeuristicReport(lang, corpus, chunkInsights);
  }

  private buildHeuristicReport(
    lang: string,
    corpus: PreparedCorpus,
    chunkInsights: ChunkInsight[],
  ): DeepAnalysisReportDocument {
    const memories = corpus.uniqueMemories;
    const tokenCounts = new Map<string, number>();
    const personCounters = new Map<string, { count: number; evidenceMemoryIds: string[] }>();
    const teamCounters = new Map<string, { count: number; evidenceMemoryIds: string[] }>();
    const projectCounters = new Map<string, { count: number; evidenceMemoryIds: string[] }>();
    const toolCounters = new Map<string, { count: number; evidenceMemoryIds: string[] }>();
    const placeCounters = new Map<string, { count: number; evidenceMemoryIds: string[] }>();
    const preferenceSignals: string[] = [];
    const habitSignals: string[] = [];
    const goalSignals: string[] = [];
    const constraintSignals: string[] = [];
    const lowQualityExamples: { memoryId: string; reason: string }[] = [];
    const duplicateClusters = corpus.duplicateClusters;

    for (const memory of memories) {
      for (const token of tokenize(memory.content)) {
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }

      for (const name of extractProperNames(memory.content)) {
        upsertCounter(personCounters, name, memory.id);
      }

      for (const hint of TEAM_HINTS) {
        if (memory.content.toLowerCase().includes(hint)) {
          upsertCounter(teamCounters, hint, memory.id);
        }
      }

      for (const hint of TOOL_HINTS) {
        if (memory.content.toLowerCase().includes(hint)) {
          upsertCounter(toolCounters, hint, memory.id);
        }
      }

      for (const hint of PLACE_HINTS) {
        if (memory.content.toLowerCase().includes(hint)) {
          upsertCounter(placeCounters, hint, memory.id);
        }
      }

      for (const tag of memory.tags) {
        if (tag.length >= 3) {
          upsertCounter(projectCounters, tag, memory.id);
        }
      }

      const lower = memory.content.toLowerCase();

      if (/(prefer|like|favorite|偏好|喜欢)/iu.test(memory.content)) {
        preferenceSignals.push(sentencePreview(memory.content));
      }
      if (/(daily|weekly|habit|usually|routine|习惯|每天|每周)/iu.test(memory.content)) {
        habitSignals.push(sentencePreview(memory.content));
      }
      if (/(goal|plan|target|roadmap|目标|计划)/iu.test(memory.content)) {
        goalSignals.push(sentencePreview(memory.content));
      }
      if (/(must|need to|should not|不要|禁止|限制|约束)/iu.test(memory.content)) {
        constraintSignals.push(sentencePreview(memory.content));
      }

      if (memory.content.trim().length < 18 || /^(ok|done|noted|收到|好的)$/iu.test(lower)) {
        lowQualityExamples.push({
          memoryId: memory.id,
          reason: 'Very short or low-information memory',
        });
      }
    }

    const highlights: DeepAnalysisThemeItem[] = pickTopEntries(tokenCounts, 8).map(([name, count]) => ({
      name,
      count,
      description: `Recurring signal across ${count} memories.`,
    }));

    const relationships = chunkInsights.flatMap((item) => item.relationships).slice(0, 16);
    const candidateNodes: DeepAnalysisCandidateNode[] = highlights.slice(0, 6).map((item) => ({
      label: item.name,
      kind: 'theme',
      count: item.count,
    }));
    const candidateEdges: DeepAnalysisCandidateEdge[] = relationships.slice(0, 10).map((item) => ({
      source: item.source,
      relation: item.relation,
      target: item.target,
      confidence: item.confidence,
    }));
    const duplicateMemoryCount = duplicateClusters.reduce(
      (sum, item) => sum + item.duplicateMemoryIds.length,
      0,
    );
    const recommendations = this.buildRecommendations(
      duplicateClusters.length,
      lowQualityExamples.length,
      relationships.length,
    );
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
      persona: {
        summary: preferenceSignals[0]
          ? `The user shows stable preferences and repeated working patterns, with strong signals around ${highlights.slice(0, 2).map((item) => item.name).join(', ')}.`
          : `The user memory corpus is dominated by recurring themes around ${highlights.slice(0, 3).map((item) => item.name).join(', ')}.`,
        preferences: preferenceSignals.slice(0, 5),
        habits: habitSignals.slice(0, 5),
        goals: goalSignals.slice(0, 5),
        constraints: constraintSignals.slice(0, 5),
      },
      themeLandscape: {
        highlights,
      },
      entities: {
        people: buildEntityGroups(personCounters),
        teams: buildEntityGroups(teamCounters),
        projects: buildEntityGroups(projectCounters),
        tools: buildEntityGroups(toolCounters),
        places: buildEntityGroups(placeCounters),
      },
      relationships,
      quality: {
        duplicateRatio: corpus.originalCount === 0
          ? 0
          : Number((duplicateMemoryCount / corpus.originalCount).toFixed(2)),
        noisyMemoryCount: lowQualityExamples.length,
        duplicateClusters,
        lowQualityExamples: lowQualityExamples.slice(0, 10),
        coverageGaps: this.buildCoverageGaps(personCounters.size, projectCounters.size, toolCounters.size),
      },
      recommendations,
      productSignals: {
        candidateNodes,
        candidateEdges,
        searchSeeds: highlights.slice(0, 8).map((item) => item.name),
      },
    };
  }

  private buildCoverageGaps(
    peopleCount: number,
    projectCount: number,
    toolCount: number,
  ): string[] {
    const gaps: string[] = [];

    if (peopleCount < 3) {
      gaps.push('People and collaborator mentions are sparse; relationship coverage may be incomplete.');
    }
    if (projectCount < 3) {
      gaps.push('Project labeling is thin; adding more explicit project references would improve grouping.');
    }
    if (toolCount < 3) {
      gaps.push('Tool and environment references are limited; operational context may be underrepresented.');
    }

    return gaps;
  }

  private buildRecommendations(
    duplicateClusterCount: number,
    lowQualityCount: number,
    relationshipCount: number,
  ): string[] {
    const recommendations: string[] = [];

    if (duplicateClusterCount > 0) {
      recommendations.push('Consider collapsing repeated memories into stronger canonical entries to reduce duplicate drift.');
    }
    if (lowQualityCount > 0) {
      recommendations.push('Filter or rewrite low-information memories so future analysis has denser evidence.');
    }
    if (relationshipCount < 3) {
      recommendations.push('Capture more explicit people, project, and collaboration statements to strengthen relationship graphs.');
    }
    if (recommendations.length === 0) {
      recommendations.push('The memory corpus is reasonably healthy; focus next on enriching entity and relationship signals.');
    }

    return recommendations;
  }
}
