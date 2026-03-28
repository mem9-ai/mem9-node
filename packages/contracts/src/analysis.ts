import type {
  AnalysisCategory,
  AnalysisEventType,
  BatchStatus,
  DeepAnalysisReportStage,
  DeepAnalysisReportStatus,
  JobStatus,
  TaxonomyMatchType,
} from './enums';

export interface DateRange {
  start: string;
  end: string;
}

export interface AnalysisOptions {
  lang: string;
  taxonomyVersion: string;
  llmEnabled: boolean;
  includeItems: boolean;
  includeSummary: boolean;
}

export interface CreateAnalysisJobRequest {
  dateRange: DateRange;
  expectedTotalMemories: number;
  expectedTotalBatches: number;
  batchSize: number;
  options: AnalysisOptions;
}

export interface CreateAnalysisJobResponse {
  jobId: string;
  status: JobStatus;
  expectedTotalBatches: number;
  uploadConcurrency: number;
  pollAfterMs: number;
}

export interface MemoryInput {
  id: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface UploadBatchRequest {
  batchHash?: string;
  memoryCount: number;
  memories: MemoryInput[];
}

export interface UploadBatchResponse {
  jobId: string;
  batchIndex: number;
  status: BatchStatus;
  payloadObjectKey: string;
  payloadHash: string;
  queuedAt: string;
}

export interface AnalysisCategoryCard {
  category: AnalysisCategory;
  count: number;
  confidence: number;
}

export interface AnalysisFacetStat {
  value: string;
  count: number;
}

export interface BatchSummary {
  batchIndex: number;
  status: BatchStatus;
  memoryCount: number;
  processedMemories: number;
  topCategories: AnalysisCategoryCard[];
  topTags: string[];
  startedAt?: string;
  completedAt?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface JobProgressSnapshot {
  expectedTotalBatches: number;
  uploadedBatches: number;
  completedBatches: number;
  failedBatches: number;
  processedMemories: number;
  resultVersion: number;
}

export interface AggregateSnapshot {
  categoryCounts: Record<string, number>;
  tagCounts: Record<string, number>;
  topicCounts: Record<string, number>;
  summarySnapshot: string[];
  resultVersion: number;
}

export interface AnalysisJobSnapshotResponse {
  jobId: string;
  status: JobStatus;
  expectedTotalMemories: number;
  expectedTotalBatches: number;
  batchSize: number;
  pipelineVersion: string;
  taxonomyVersion: string;
  llmEnabled: boolean;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  expiresAt?: string | null;
  progress: JobProgressSnapshot;
  aggregate: AggregateSnapshot;
  aggregateCards: AnalysisCategoryCard[];
  topTagStats: AnalysisFacetStat[];
  topTopicStats: AnalysisFacetStat[];
  topTags: string[];
  topTopics: string[];
  batchSummaries: BatchSummary[];
}

export interface AnalysisEvent {
  version: number;
  type: AnalysisEventType;
  timestamp: string;
  jobId: string;
  batchIndex?: number;
  status?: JobStatus | BatchStatus;
  message: string;
  delta?: {
    processedMemories?: number;
    completedBatches?: number;
    failedBatches?: number;
  };
}

export interface AnalysisJobUpdatesResponse {
  cursor: number;
  nextCursor: number;
  events: AnalysisEvent[];
  completedBatchResults: BatchSummary[];
  aggregate: AggregateSnapshot;
  progress: JobProgressSnapshot;
}

export interface FinalizeAnalysisJobResponse {
  jobId: string;
  status: JobStatus;
  uploadedBatches: number;
  expectedTotalBatches: number;
}

export interface CancelAnalysisJobResponse {
  jobId: string;
  status: JobStatus;
}

export interface TaxonomyRuleDefinition {
  id: string;
  version: string;
  category: AnalysisCategory;
  label: string;
  lang: string;
  matchType: TaxonomyMatchType;
  pattern: string;
  weight: number;
  enabled: boolean;
}

export interface TaxonomyResponse {
  version: string;
  updatedAt: string;
  categories: AnalysisCategory[];
  rules: TaxonomyRuleDefinition[];
}

export interface AnalysisBatchMessage {
  jobId: string;
  batchIndex: number;
  payloadObjectKey: string;
  payloadHash: string;
  memoryCount: number;
  pipelineVersion: string;
  taxonomyVersion: string;
  llmEnabled: boolean;
  traceId: string;
}

export interface AnalysisLlmMessage {
  messageType: 'analysis_llm';
  jobId: string;
  batchIndex: number;
  memoryIds: string[];
  taxonomyVersion: string;
  traceId: string;
}

export interface DeepAnalysisMemorySnapshot {
  id: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
  memoryType?: string;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface DeepAnalysisOverviewSection {
  memoryCount: number;
  deduplicatedMemoryCount: number;
  generatedAt: string;
  lang: string;
  timeSpan: {
    start: string | null;
    end: string | null;
  };
}

export interface DeepAnalysisPersonaSection {
  summary: string;
  workingStyle?: string[];
  goals?: string[];
  preferences?: string[];
  constraints?: string[];
  decisionSignals?: string[];
  notableRoutines?: string[];
  contradictionsOrTensions?: string[];
  evidenceHighlights?: DeepAnalysisEvidenceHighlight[];
  habits?: string[];
}

export interface DeepAnalysisThemeItem {
  name: string;
  count: number;
  description: string;
}

export interface DeepAnalysisEntityGroup {
  label: string;
  count: number;
  evidenceMemoryIds: string[];
}

export interface DeepAnalysisRelationship {
  source: string;
  relation: string;
  target: string;
  confidence: number;
  evidenceMemoryIds: string[];
  evidenceExcerpts: string[];
}

export interface DeepAnalysisQualityIssue {
  memoryId: string;
  reason: string;
}

export interface DeepAnalysisDuplicateCluster {
  canonicalMemoryId: string;
  duplicateMemoryIds: string[];
}

export interface DeepAnalysisEvidenceHighlight {
  title: string;
  detail: string;
  memoryIds: string[];
}

export interface DeepAnalysisDuplicateExportRow {
  duplicateMemoryId: string;
  clusterIndex: number;
  canonicalPreview: string;
  duplicatePreview: string;
  reason: string;
}

export interface DeepAnalysisCandidateNode {
  label: string;
  kind: string;
  count: number;
}

export interface DeepAnalysisCandidateEdge {
  source: string;
  relation: string;
  target: string;
  confidence: number;
}

export interface DeepAnalysisReportDocument {
  overview: DeepAnalysisOverviewSection;
  persona: DeepAnalysisPersonaSection;
  themeLandscape: {
    highlights: DeepAnalysisThemeItem[];
  };
  entities: {
    people: DeepAnalysisEntityGroup[];
    teams: DeepAnalysisEntityGroup[];
    projects: DeepAnalysisEntityGroup[];
    tools: DeepAnalysisEntityGroup[];
    places: DeepAnalysisEntityGroup[];
  };
  relationships: DeepAnalysisRelationship[];
  quality: {
    duplicateRatio: number;
    duplicateMemoryCount?: number;
    noisyMemoryCount: number;
    duplicateClusters: DeepAnalysisDuplicateCluster[];
    lowQualityExamples: DeepAnalysisQualityIssue[];
    coverageGaps: string[];
  };
  recommendations: string[];
  productSignals: {
    candidateNodes: DeepAnalysisCandidateNode[];
    candidateEdges: DeepAnalysisCandidateEdge[];
    searchSeeds: string[];
  };
}

export interface DeepAnalysisReportPreview {
  generatedAt: string;
  summary: string;
  topThemes: string[];
  keyRecommendations: string[];
}

export interface CreateDeepAnalysisReportRequest {
  lang: string;
  timezone: string;
}

export interface CreateDeepAnalysisReportResponse {
  reportId: string;
  status: DeepAnalysisReportStatus;
  stage: DeepAnalysisReportStage;
  progressPercent: number;
  requestedAt: string;
  memoryCount: number;
}

export interface DeepAnalysisReportListItem {
  id: string;
  status: DeepAnalysisReportStatus;
  stage: DeepAnalysisReportStage;
  progressPercent: number;
  lang: string;
  timezone: string;
  memoryCount: number;
  requestedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  preview: DeepAnalysisReportPreview | null;
}

export interface DeepAnalysisReportDetail extends DeepAnalysisReportListItem {
  report: DeepAnalysisReportDocument | null;
}

export interface ListDeepAnalysisReportsResponse {
  reports: DeepAnalysisReportListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface DeepAnalysisReportMessage {
  messageType: 'deep_report';
  reportId: string;
  traceId: string;
}

export type AnalysisLlmQueueMessage = AnalysisLlmMessage | DeepAnalysisReportMessage;

export interface ProgressEventPayload {
  progress: JobProgressSnapshot;
  aggregate: AggregateSnapshot;
  event: AnalysisEvent;
  batchResult?: BatchSummary;
}

export interface AggregateMergeInput {
  batchIndex: number;
  expectedTotalBatches: number;
  processedMemories: number;
  categoryCounts: Record<string, number>;
  tagCounts: Record<string, number>;
  topicCounts: Record<string, number>;
  summarySnapshot: string[];
  batchResult: BatchSummary;
}
