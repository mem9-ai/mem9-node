export type MemorySignalDimension =
  | 'long_term_goal'
  | 'focus_area'
  | 'emotion'
  | 'preference_signal'
  | 'growth_signal';

export interface AnalyzeMemorySourceChangesResponse {
  total: number;
  memoryCount: number;
  model: string;
  dimensions: MemoryAnalysisChangeDimensionGroup[];
}

export interface MemoryAnalysisChangePeriod {
  start: string;
  end: string;
}

export interface MemoryAnalysisChangeEvidence {
  evidenceId: string;
  quote: string;
  review?: MemoryAnalysisEvidenceReview;
}

export interface MemoryAnalysisEvidenceReview {
  correctness?: 'correct' | 'incorrect';
  edited?: boolean;
  editVersion?: number;
  editedAt?: string;
}

export interface MemoryAnalysisChange {
  title: string;
  summary: string;
  score?: number;
  period: MemoryAnalysisChangePeriod;
  evidence: MemoryAnalysisChangeEvidence[];
}

export interface MemoryAnalysisChangeDimensionGroup {
  dimension: MemorySignalDimension;
  summary: string;
  changes: MemoryAnalysisChange[];
}

export interface MemoryAnalysisPeriodSummary {
  period: {
    start: string;
    end: string;
  };
  dimensions: MemoryAnalysisPeriodDimensionGroup[];
}

export interface MemoryAnalysisPeriodInsight {
  title: string;
  summary: string;
  evidence: MemoryAnalysisPeriodInsightEvidence[];
}

export interface MemoryAnalysisPeriodInsightEvidence {
  evidenceId: string;
  quote: string;
  review?: MemoryAnalysisEvidenceReview;
}

export interface MemoryAnalysisPeriodDimensionGroup {
  dimension: MemorySignalDimension;
  insights: MemoryAnalysisPeriodInsight[];
}

export interface AnalyzeMemorySourcePeriodSummaryResponse {
  total: number;
  memoryCount: number;
  model: string;
  periods: MemoryAnalysisPeriodSummary[];
}

export interface MemoryAnalysisReportResponse {
  report_id: number;
  template_id: string;
  report_content: string;
  generated_at: string;
  startTime: string | null;
  endTime: string | null;
  render_status: 'fail' | 'success';
  fail_reason: string | null;
  memory_count: number;
}

export interface PromptMemory {
  id: string;
  createdAt?: string;
  text: string;
  review?: MemoryAnalysisEvidenceReview;
}

export interface PromptPeriod {
  periodKey: string;
  start: string;
  end: string;
  cacheable: boolean;
  memories: PromptMemory[];
}

export const MEMORY_ANALYSIS_DIMENSIONS = new Set<MemorySignalDimension>([
  'long_term_goal',
  'focus_area',
  'emotion',
  'preference_signal',
  'growth_signal',
]);
