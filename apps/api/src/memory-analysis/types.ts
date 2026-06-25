export type MemorySignalDimension =
  | 'long_term_goal'
  | 'focus_area'
  | 'emotion'
  | 'preference_signal'
  | 'growth_signal';

export interface MemoryAnalysisInsightEvidence {
  time?: string;
  quote: string;
}

export interface MemoryAnalysisInsightTime {
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface MemoryAnalysisInsight {
  summary: string;
  time: MemoryAnalysisInsightTime;
  evidence: MemoryAnalysisInsightEvidence[];
}

export interface MemoryAnalysisDimensionGroup {
  dimension: MemorySignalDimension;
  insights: MemoryAnalysisInsight[];
}

export interface AnalyzeMemorySourceChangesResponse {
  total: number;
  limit: number;
  offset: number;
  model: string;
  dimensions: MemoryAnalysisDimensionGroup[];
}

export interface MemoryAnalysisPeriodSummary {
  period: {
    start: string;
    end: string;
  };
  dimensions: MemoryAnalysisPeriodDimensionGroup[];
}

export interface MemoryAnalysisPeriodInsight {
  summary: string;
  evidence: string[];
}

export interface MemoryAnalysisPeriodDimensionGroup {
  dimension: MemorySignalDimension;
  insights: MemoryAnalysisPeriodInsight[];
}

export interface AnalyzeMemorySourcePeriodSummaryResponse {
  total: number;
  limit: number;
  offset: number;
  model: string;
  periods: MemoryAnalysisPeriodSummary[];
}

export interface PromptMemory {
  id: string;
  createdAt?: string;
  text: string;
}

export interface PromptPeriod {
  periodKey: string;
  start: string;
  end: string;
  memories: PromptMemory[];
}

export const MEMORY_ANALYSIS_DIMENSIONS = new Set<MemorySignalDimension>([
  'long_term_goal',
  'focus_area',
  'emotion',
  'preference_signal',
  'growth_signal',
]);
