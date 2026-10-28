import type { Prisma } from '@prisma/client';

import { AppError } from './errors';

export const DEEP_ANALYSIS_LEASE_MS = 5 * 60 * 1000;
export const DEEP_ANALYSIS_HEARTBEAT_MS = 30 * 1000;
export const DEEP_ANALYSIS_INITIAL_WAIT_MS = 5 * 60 * 1000;
export const DEEP_ANALYSIS_QUEUE_WAIT_MS = 30 * 60 * 1000;
export const DEEP_ANALYSIS_SOURCE_DEADLINE_MS = 30 * 60 * 1000;
export const DEEP_ANALYSIS_WORKER_DEADLINE_MS = 60 * 60 * 1000;

interface DeepAnalysisLeaseRepository {
  claimDeepAnalysisExecution(
    reportId: string,
    fingerprint: Buffer,
    phase: 'source' | 'worker',
  ): Promise<string | null>;
  renewDeepAnalysisExecution(
    reportId: string,
    fingerprint: Buffer,
    token: string,
  ): Promise<boolean>;
  updateDeepAnalysisExecution(
    reportId: string,
    fingerprint: Buffer,
    token: string,
    data: Prisma.DeepAnalysisReportUncheckedUpdateInput,
  ): Promise<void>;
  handoffDeepAnalysisExecution(
    reportId: string,
    fingerprint: Buffer,
    token: string,
    memoryCount: number,
  ): Promise<void>;
}

export interface DeepAnalysisExecutionLease {
  readonly token: string;
  assertActive(): Promise<void>;
  update(data: Prisma.DeepAnalysisReportUncheckedUpdateInput): Promise<void>;
  handoff(memoryCount: number): Promise<void>;
}

export function isDeepAnalysisExecutionLeaseLost(error: unknown): boolean {
  return error instanceof AppError && error.code === 'DEEP_ANALYSIS_LEASE_LOST';
}

function leaseLost(cause?: unknown): AppError {
  return new AppError('Deep analysis execution lease is no longer active', {
    statusCode: 409,
    code: 'DEEP_ANALYSIS_LEASE_LOST',
    cause,
  });
}

export async function withDeepAnalysisExecutionLease<T>(
  repository: DeepAnalysisLeaseRepository,
  reportId: string,
  fingerprint: Buffer,
  phase: 'source' | 'worker',
  work: (lease: DeepAnalysisExecutionLease) => Promise<T>,
): Promise<T | undefined> {
  let token: string | null;
  try {
    token = await repository.claimDeepAnalysisExecution(
      reportId,
      fingerprint,
      phase,
    );
  } catch (error) {
    if (isDeepAnalysisExecutionLeaseLost(error)) {
      return undefined;
    }
    throw error;
  }
  if (token === null) {
    return undefined;
  }

  let lost = false;
  let released = false;
  let closed = false;
  let renewal: Promise<void> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stopHeartbeat = (): void => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };
  const markLost = (): void => {
    lost = true;
    stopHeartbeat();
  };
  const checkLocalLease = (): void => {
    if (lost || released || closed) {
      throw leaseLost();
    }
  };
  const renew = async (): Promise<void> => {
    checkLocalLease();
    if (renewal !== undefined) {
      return renewal;
    }
    renewal = (async () => {
      try {
        const active = await repository.renewDeepAnalysisExecution(
          reportId,
          fingerprint,
          token,
        );
        if (!active) {
          throw leaseLost();
        }
      } catch (error) {
        // An uncertain heartbeat must not allow additional writes by this process.
        markLost();
        throw isDeepAnalysisExecutionLeaseLost(error)
          ? error
          : leaseLost(error);
      } finally {
        renewal = undefined;
      }
    })();
    return renewal;
  };
  const assertActive = async (): Promise<void> => {
    await renew();
    checkLocalLease();
  };
  const lease: DeepAnalysisExecutionLease = {
    token,
    assertActive,
    async update(data) {
      await assertActive();
      try {
        await repository.updateDeepAnalysisExecution(
          reportId,
          fingerprint,
          token,
          data,
        );
        const status =
          typeof data.status === 'string' ? data.status : data.status?.set;
        if (status === 'COMPLETED' || status === 'FAILED') {
          released = true;
          stopHeartbeat();
        }
      } catch (error) {
        if (isDeepAnalysisExecutionLeaseLost(error)) {
          markLost();
        }
        throw error;
      }
    },
    async handoff(memoryCount) {
      await assertActive();
      // The handoff retires this source lease; do not heartbeat queued work.
      stopHeartbeat();
      try {
        await repository.handoffDeepAnalysisExecution(
          reportId,
          fingerprint,
          token,
          memoryCount,
        );
        released = true;
      } catch (error) {
        markLost();
        throw error;
      }
    },
  };

  heartbeat = setInterval(() => {
    void renew().catch(() => {
      // renew already fenced this local execution. Never reject from a timer.
    });
  }, DEEP_ANALYSIS_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    const result = await work(lease);
    if (lost) {
      return undefined;
    }
    return result;
  } catch (error) {
    if (isDeepAnalysisExecutionLeaseLost(error)) {
      return undefined;
    }
    throw error;
  } finally {
    closed = true;
    stopHeartbeat();
  }
}
