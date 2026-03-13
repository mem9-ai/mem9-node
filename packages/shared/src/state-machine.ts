import type { BatchStatus, JobStatus } from '@mem9/contracts';

import { AppError } from './errors';

const allowedJobTransitions: Record<JobStatus, JobStatus[]> = {
  CREATED: ['UPLOADING', 'CANCELLED', 'EXPIRED'],
  UPLOADING: ['PROCESSING', 'PARTIAL', 'CANCELLED', 'FAILED', 'EXPIRED'],
  PROCESSING: ['PARTIAL', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PARTIAL: ['PROCESSING', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  COMPLETED: [],
  PARTIAL_FAILED: ['PROCESSING', 'FAILED', 'CANCELLED', 'EXPIRED'],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

const allowedBatchTransitions: Record<BatchStatus, BatchStatus[]> = {
  EXPECTED: ['UPLOADED', 'FAILED'],
  UPLOADED: ['QUEUED', 'FAILED'],
  QUEUED: ['RUNNING', 'RETRYING', 'FAILED', 'DLQ'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'RETRYING', 'DLQ'],
  SUCCEEDED: [],
  FAILED: ['RETRYING', 'DLQ'],
  RETRYING: ['RUNNING', 'FAILED', 'DLQ'],
  DLQ: [],
};

export function assertJobTransition(current: JobStatus, next: JobStatus): void {
  if (!allowedJobTransitions[current].includes(next)) {
    throw new AppError(`Invalid job status transition ${current} -> ${next}`, {
      statusCode: 409,
      code: 'INVALID_JOB_STATUS_TRANSITION',
      details: { current, next },
    });
  }
}

export function assertBatchTransition(current: BatchStatus, next: BatchStatus): void {
  if (!allowedBatchTransitions[current].includes(next)) {
    throw new AppError(`Invalid batch status transition ${current} -> ${next}`, {
      statusCode: 409,
      code: 'INVALID_BATCH_STATUS_TRANSITION',
      details: { current, next },
    });
  }
}
