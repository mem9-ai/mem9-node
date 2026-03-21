import type {
  AnalysisCategory,
  AnalysisEventType,
  BatchStatus,
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
  jobId: string;
  batchIndex: number;
  memoryIds: string[];
  taxonomyVersion: string;
  traceId: string;
}

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
