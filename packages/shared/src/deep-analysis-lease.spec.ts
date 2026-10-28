import type { Prisma } from '@prisma/client';

import {
  DEEP_ANALYSIS_HEARTBEAT_MS,
  DEEP_ANALYSIS_INITIAL_WAIT_MS,
  DEEP_ANALYSIS_LEASE_MS,
  DEEP_ANALYSIS_QUEUE_WAIT_MS,
  DEEP_ANALYSIS_SOURCE_DEADLINE_MS,
  DEEP_ANALYSIS_WORKER_DEADLINE_MS,
  type DeepAnalysisExecutionLease,
  isDeepAnalysisExecutionLeaseLost,
  withDeepAnalysisExecutionLease,
} from './deep-analysis-lease';
import { AppError } from './errors';

const fingerprint = Buffer.alloc(32, 7);
const reportId = 'dar_report';
const token = 'execution-token';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup() {
  return {
    claimDeepAnalysisExecution: jest
      .fn<Promise<string | null>, [string, Buffer, 'source' | 'worker']>()
      .mockResolvedValue(token),
    renewDeepAnalysisExecution: jest
      .fn<Promise<boolean>, [string, Buffer, string]>()
      .mockResolvedValue(true),
    updateDeepAnalysisExecution: jest
      .fn<
        Promise<void>,
        [string, Buffer, string, Prisma.DeepAnalysisReportUncheckedUpdateInput]
      >()
      .mockResolvedValue(undefined),
    handoffDeepAnalysisExecution: jest
      .fn<Promise<void>, [string, Buffer, string, number]>()
      .mockResolvedValue(undefined),
  };
}

function lostLeaseError() {
  return new AppError('Lease expired', {
    statusCode: 409,
    code: 'DEEP_ANALYSIS_LEASE_LOST',
  });
}

describe('deep analysis execution lease', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses a bounded heartbeat and distinct source, worker, and queue deadlines', () => {
    expect(DEEP_ANALYSIS_LEASE_MS).toBe(5 * 60 * 1000);
    expect(DEEP_ANALYSIS_HEARTBEAT_MS).toBe(30 * 1000);
    expect(DEEP_ANALYSIS_INITIAL_WAIT_MS).toBe(5 * 60 * 1000);
    expect(DEEP_ANALYSIS_QUEUE_WAIT_MS).toBe(30 * 60 * 1000);
    expect(DEEP_ANALYSIS_SOURCE_DEADLINE_MS).toBe(30 * 60 * 1000);
    expect(DEEP_ANALYSIS_WORKER_DEADLINE_MS).toBe(60 * 60 * 1000);
  });

  it('does no work or heartbeats when the report cannot be claimed', async () => {
    const repository = setup();
    repository.claimDeepAnalysisExecution.mockResolvedValue(null);
    const work = jest.fn();

    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        work,
      ),
    ).resolves.toBeUndefined();
    expect(repository.claimDeepAnalysisExecution).toHaveBeenCalledWith(
      reportId,
      fingerprint,
      'worker',
    );
    expect(work).not.toHaveBeenCalled();
    expect(repository.renewDeepAnalysisExecution).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares the claimed token with every fenced operation and returns the callback result', async () => {
    const repository = setup();
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        async (lease) => {
          expect(lease.token).toBe(token);
          await lease.assertActive();
          await lease.update({ progressPercent: 25 });
          return 'result';
        },
      ),
    ).resolves.toBe('result');

    expect(repository.renewDeepAnalysisExecution).toHaveBeenCalledWith(
      reportId,
      fingerprint,
      token,
    );
    expect(repository.updateDeepAnalysisExecution).toHaveBeenCalledWith(
      reportId,
      fingerprint,
      token,
      { progressPercent: 25 },
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('renews while work is pending and clears the timer after completion', async () => {
    const repository = setup();
    const started = deferred<void>();
    const finish = deferred<string>();
    const execution = withDeepAnalysisExecutionLease(
      repository,
      reportId,
      fingerprint,
      'worker',
      async () => {
        started.resolve();
        return finish.promise;
      },
    );
    await started.promise;
    await jest.advanceTimersByTimeAsync(DEEP_ANALYSIS_HEARTBEAT_MS * 3);
    expect(repository.renewDeepAnalysisExecution).toHaveBeenCalledTimes(3);

    finish.resolve('done');
    await expect(execution).resolves.toBe('done');
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(DEEP_ANALYSIS_HEARTBEAT_MS);
    expect(repository.renewDeepAnalysisExecution).toHaveBeenCalledTimes(3);
  });

  it('does not overlap heartbeat and explicit renewals', async () => {
    const repository = setup();
    const renewal = deferred<boolean>();
    repository.renewDeepAnalysisExecution.mockReturnValue(renewal.promise);
    const started = deferred<DeepAnalysisExecutionLease>();
    const finish = deferred<void>();
    const execution = withDeepAnalysisExecutionLease(
      repository,
      reportId,
      fingerprint,
      'worker',
      async (lease) => {
        started.resolve(lease);
        await finish.promise;
      },
    );
    const lease = await started.promise;
    await jest.advanceTimersByTimeAsync(DEEP_ANALYSIS_HEARTBEAT_MS);
    const assertion = lease.assertActive();
    await jest.advanceTimersByTimeAsync(DEEP_ANALYSIS_HEARTBEAT_MS * 3);
    expect(repository.renewDeepAnalysisExecution).toHaveBeenCalledTimes(1);

    renewal.resolve(true);
    await assertion;
    finish.resolve();
    await execution;
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['expired', 'database error'])(
    'stops delayed work after a heartbeat reports %s',
    async (reason) => {
      const repository = setup();
      if (reason === 'expired') {
        repository.renewDeepAnalysisExecution.mockResolvedValue(false);
      } else {
        repository.renewDeepAnalysisExecution.mockRejectedValue(
          new Error('Database unavailable'),
        );
      }
      const started = deferred<void>();
      const finish = deferred<void>();
      const execution = withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        async (lease) => {
          started.resolve();
          await finish.promise;
          await lease.update({ status: 'COMPLETED' });
          return 'must not publish';
        },
      );
      await started.promise;
      await jest.advanceTimersByTimeAsync(DEEP_ANALYSIS_HEARTBEAT_MS);
      expect(jest.getTimerCount()).toBe(0);
      finish.resolve();

      await expect(execution).resolves.toBeUndefined();
      expect(repository.renewDeepAnalysisExecution).toHaveBeenCalledTimes(1);
      expect(repository.updateDeepAnalysisExecution).not.toHaveBeenCalled();
    },
  );

  it('does not retry or write when an explicit renewal discovers lease loss', async () => {
    const repository = setup();
    repository.renewDeepAnalysisExecution.mockResolvedValue(false);
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'source',
        async (lease) => {
          await lease.update({ progressPercent: 5 });
        },
      ),
    ).resolves.toBeUndefined();
    expect(repository.claimDeepAnalysisExecution).toHaveBeenCalledTimes(1);
    expect(repository.updateDeepAnalysisExecution).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('remembers a lost fence so callback cleanup cannot issue another update', async () => {
    const repository = setup();
    repository.updateDeepAnalysisExecution.mockRejectedValue(lostLeaseError());
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        async (lease) => {
          try {
            await lease.update({ progressPercent: 20 });
          } catch (error) {
            expect(isDeepAnalysisExecutionLeaseLost(error)).toBe(true);
            await lease.update({ status: 'FAILED' });
          }
        },
      ),
    ).resolves.toBeUndefined();
    expect(repository.updateDeepAnalysisExecution).toHaveBeenCalledTimes(1);
    expect(repository.renewDeepAnalysisExecution).toHaveBeenCalledTimes(1);
  });

  it('allows callback failure bookkeeping while the lease is still active', async () => {
    const repository = setup();
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        async (lease) => {
          await lease.update({
            status: 'FAILED',
            errorCode: 'UPSTREAM_FAILED',
          });
          return 'failure persisted';
        },
      ),
    ).resolves.toBe('failure persisted');
    expect(repository.updateDeepAnalysisExecution).toHaveBeenCalledWith(
      reportId,
      fingerprint,
      token,
      {
        status: 'FAILED',
        errorCode: 'UPSTREAM_FAILED',
      },
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retires the source lease after a successful handoff', async () => {
    const repository = setup();
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'source',
        async (lease) => {
          await lease.handoff(42);
          expect(jest.getTimerCount()).toBe(0);
          await expect(
            lease.update({ status: 'FAILED' }),
          ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
          await jest.advanceTimersByTimeAsync(DEEP_ANALYSIS_HEARTBEAT_MS * 2);
          return 'queued';
        },
      ),
    ).resolves.toBe('queued');
    expect(repository.handoffDeepAnalysisExecution).toHaveBeenCalledWith(
      reportId,
      fingerprint,
      token,
      42,
    );
    expect(repository.renewDeepAnalysisExecution).toHaveBeenCalledTimes(1);
    expect(repository.updateDeepAnalysisExecution).not.toHaveBeenCalled();
  });

  it('safely stops when the source loses its fence during handoff', async () => {
    const repository = setup();
    repository.handoffDeepAnalysisExecution.mockRejectedValue(lostLeaseError());
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'source',
        async (lease) => {
          await lease.handoff(42);
          throw new Error('must not enqueue after losing the lease');
        },
      ),
    ).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['complete', 'fail'])(
    'fences retained callbacks after work ends with %s',
    async (outcome) => {
      const repository = setup();
      let retained!: DeepAnalysisExecutionLease;
      const failure = new Error('Callback failed');
      const execution = withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        async (lease) => {
          retained = lease;
          if (outcome === 'fail') {
            throw failure;
          }
          return 'done';
        },
      );
      if (outcome === 'fail') {
        await expect(execution).rejects.toBe(failure);
      } else {
        await expect(execution).resolves.toBe('done');
      }

      await expect(retained.assertActive()).rejects.toMatchObject({
        code: 'DEEP_ANALYSIS_LEASE_LOST',
      });
      await expect(
        retained.update({ progressPercent: 75 }),
      ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
      await expect(retained.handoff(42)).rejects.toMatchObject({
        code: 'DEEP_ANALYSIS_LEASE_LOST',
      });
      expect(repository.renewDeepAnalysisExecution).not.toHaveBeenCalled();
      expect(repository.updateDeepAnalysisExecution).not.toHaveBeenCalled();
      expect(repository.handoffDeepAnalysisExecution).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('propagates operational write errors rather than treating them as lease loss', async () => {
    const repository = setup();
    const failure = new Error('Database write failed');
    repository.updateDeepAnalysisExecution.mockRejectedValue(failure);
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        async (lease) => {
          await lease.update({ progressPercent: 25 });
        },
      ),
    ).rejects.toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propagates claim errors except the explicit lease-lost error', async () => {
    const repository = setup();
    const failure = new Error('Database unavailable');
    repository.claimDeepAnalysisExecution
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(lostLeaseError());
    const work = jest.fn();
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        work,
      ),
    ).rejects.toBe(failure);
    await expect(
      withDeepAnalysisExecutionLease(
        repository,
        reportId,
        fingerprint,
        'worker',
        work,
      ),
    ).resolves.toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('only recognizes the dedicated AppError as lease loss', () => {
    expect(isDeepAnalysisExecutionLeaseLost(lostLeaseError())).toBe(true);
    expect(
      isDeepAnalysisExecutionLeaseLost(new Error('DEEP_ANALYSIS_LEASE_LOST')),
    ).toBe(false);
    expect(
      isDeepAnalysisExecutionLeaseLost(
        new AppError('Other', { statusCode: 409, code: 'OTHER' }),
      ),
    ).toBe(false);
  });
});
