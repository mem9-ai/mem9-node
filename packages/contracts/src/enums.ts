export const JOB_STATUSES = [
  'CREATED',
  'UPLOADING',
  'PROCESSING',
  'PARTIAL',
  'COMPLETED',
  'PARTIAL_FAILED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const BATCH_STATUSES = [
  'EXPECTED',
  'UPLOADED',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'RETRYING',
  'DLQ',
] as const;

export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const API_KEY_SUBJECT_STATUSES = ['ACTIVE', 'DISABLED', 'PENDING'] as const;

export type ApiKeySubjectStatus = (typeof API_KEY_SUBJECT_STATUSES)[number];

export const TAXONOMY_MATCH_TYPES = ['keyword', 'regex', 'phrase'] as const;

export type TaxonomyMatchType = (typeof TAXONOMY_MATCH_TYPES)[number];

export const ANALYSIS_CATEGORIES = [
  'identity',
  'emotion',
  'preference',
  'experience',
  'activity',
] as const;

export type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number];

export const EVENT_TYPES = [
  'job_created',
  'batch_uploaded',
  'batch_started',
  'batch_completed',
  'batch_failed',
  'job_finalized',
  'job_cancelled',
] as const;

export type AnalysisEventType = (typeof EVENT_TYPES)[number];
