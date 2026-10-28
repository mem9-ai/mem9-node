import type { DeepAnalysisReport, Prisma } from '@prisma/client';

import { AnalysisRepository } from './analysis-repository';
import {
  DEEP_ANALYSIS_LEASE_MS,
  DEEP_ANALYSIS_QUEUE_WAIT_MS,
  DEEP_ANALYSIS_SOURCE_DEADLINE_MS,
  DEEP_ANALYSIS_WORKER_DEADLINE_MS,
} from './deep-analysis-lease';

const fingerprint = Buffer.alloc(32, 4);
const otherFingerprint = Buffer.alloc(32, 9);
const now = new Date('2026-10-28T12:00:00.000Z');

function makeReport(
  overrides: Partial<DeepAnalysisReport> = {},
): DeepAnalysisReport {
  return {
    id: 'dar_report',
    apiKeyFingerprint: new Uint8Array(fingerprint),
    deletedAt: null,
    executionToken: null,
    leaseExpiresAt: new Date(now.getTime() + DEEP_ANALYSIS_LEASE_MS),
    executionDeadlineAt: null,
    requestDayKey: '2026-10-28@UTC#dar_report',
    status: 'QUEUED',
    stage: 'FETCH_SOURCE',
    progressPercent: 0,
    lang: 'en',
    timezone: 'UTC',
    memoryCount: 1,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    previewJson: null,
    reportObjectKey: null,
    sourceSnapshotObjectKey: 'source.json.gz',
    internalComment: null,
    ...overrides,
  };
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    return Buffer.from(actual).equals(Buffer.from(expected));
  }
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

function matchesField(actual: unknown, expected: unknown): boolean {
  if (
    expected === null ||
    typeof expected !== 'object' ||
    expected instanceof Date ||
    expected instanceof Uint8Array
  ) {
    return sameValue(actual, expected);
  }
  const filter = expected as Record<string, unknown>;
  return Object.entries(filter).every(([operator, value]) => {
    if (operator === 'equals') {
      return sameValue(actual, value);
    }
    if (operator === 'in' && Array.isArray(value)) {
      return value.some((entry: unknown) => sameValue(actual, entry));
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
      // MySQL comparison against NULL is not true.
      if (actual === null) {
        return false;
      }
      if (!(actual instanceof Date) || !(value instanceof Date)) {
        throw new Error(`Unsupported date comparison: ${operator}`);
      }
      const actualTime = actual.getTime();
      const expectedTime = value.getTime();
      if (operator === 'gt') return actualTime > expectedTime;
      if (operator === 'gte') return actualTime >= expectedTime;
      if (operator === 'lt') return actualTime < expectedTime;
      return actualTime <= expectedTime;
    }
    throw new Error(`Unsupported test filter: ${operator}`);
  });
}

function matches(
  report: DeepAnalysisReport,
  where: Prisma.DeepAnalysisReportWhereInput,
): boolean {
  const fields = report as unknown as Record<string, unknown>;
  return Object.entries(where).every(([field, filter]) => {
    if (field === 'OR') {
      return (filter as Prisma.DeepAnalysisReportWhereInput[]).some((item) =>
        matches(report, item),
      );
    }
    if (field === 'AND') {
      const items = Array.isArray(filter) ? filter : [filter];
      return (items as Prisma.DeepAnalysisReportWhereInput[]).every((item) =>
        matches(report, item),
      );
    }
    return matchesField(fields[field], filter);
  });
}

function setup(...reports: DeepAnalysisReport[]) {
  let beforeNextUpdate: (() => Promise<void>) | undefined;
  const updateMany = jest.fn(
    async (args: Prisma.DeepAnalysisReportUpdateManyArgs) => {
      const wait = beforeNextUpdate;
      beforeNextUpdate = undefined;
      if (wait !== undefined) {
        await wait();
      }
      // The predicate is evaluated against current state at mutation time, as a
      // conditional SQL UPDATE is. This models CAS ordering, not MySQL locking.
      let count = 0;
      for (const report of reports) {
        if (!matches(report, args.where ?? {})) {
          continue;
        }
        const fields = report as unknown as Record<string, unknown>;
        for (const [field, update] of Object.entries(args.data)) {
          fields[field] =
            update !== null && typeof update === 'object' && 'set' in update
              ? update.set
              : update;
        }
        count += 1;
      }
      return { count };
    },
  );
  const repository = new AnalysisRepository({
    deepAnalysisReport: { updateMany },
  } as never);
  return {
    repository,
    updateMany,
    delayNextUpdate(this: void) {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeNextUpdate = () => barrier;
      return release;
    },
  };
}

describe('deep analysis recovery conditional updates', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fails a rejected queued send immediately while retaining quota history', async () => {
    const report = makeReport({ stage: 'PREPROCESS' });
    const { repository } = setup(report);
    await expect(repository.failRejectedDeepAnalysisEnqueue(report.id, fingerprint)).resolves.toBe(true);
    expect(report).toMatchObject({
      status: 'FAILED', errorCode: 'DEEP_ANALYSIS_ENQUEUE_REJECTED',
      executionToken: null, leaseExpiresAt: null, executionDeadlineAt: null,
      requestedAt: now, requestDayKey: '2026-10-28@UTC#dar_report',
    });
  });

  it('does not fail a worker that claimed before rejection was recorded', async () => {
    const report = makeReport({ stage: 'PREPROCESS' });
    const { repository, delayNextUpdate } = setup(report);
    const release = delayNextUpdate();
    const failure = repository.failRejectedDeepAnalysisEnqueue(report.id, fingerprint);
    const token = await repository.claimDeepAnalysisExecution(report.id, fingerprint, 'worker');
    release();
    await expect(failure).resolves.toBe(false);
    expect(report.status).toBe('PREPARING');
    expect(report.executionToken).toBe(token);
  });

  it.each([
    { stage: 'FETCH_SOURCE' }, { deletedAt: now }, { leaseExpiresAt: now },
    { status: 'COMPLETED' }, { status: 'FAILED' },
    { apiKeyFingerprint: new Uint8Array(otherFingerprint) },
  ] as Partial<DeepAnalysisReport>[])('does not overwrite ineligible queued rejection state: %j', async (overrides) => {
    const report = makeReport({ stage: 'PREPROCESS', ...overrides });
    const before = { ...report };
    const { repository } = setup(report);
    await expect(repository.failRejectedDeepAnalysisEnqueue(report.id, fingerprint)).resolves.toBe(false);
    expect(report).toEqual(before);
  });

  it.each(['source', 'worker'] as const)(
    'allows only one %s claimant and assigns its bounded deadline',
    async (phase) => {
      const report = makeReport({
        stage: phase === 'source' ? 'FETCH_SOURCE' : 'PREPROCESS',
      });
      const { repository } = setup(report);
      const claims = await Promise.all([
        repository.claimDeepAnalysisExecution(report.id, fingerprint, phase),
        repository.claimDeepAnalysisExecution(report.id, fingerprint, phase),
      ]);

      expect(claims.filter((token) => token !== null)).toHaveLength(1);
      expect(report.executionToken).toBe(
        claims.find((token) => token !== null),
      );
      expect(report.status).toBe('PREPARING');
      expect(report.startedAt).toEqual(now);
      expect(report.leaseExpiresAt).toEqual(
        new Date(now.getTime() + DEEP_ANALYSIS_LEASE_MS),
      );
      expect(report.executionDeadlineAt).toEqual(
        new Date(
          now.getTime() +
            (phase === 'source'
              ? DEEP_ANALYSIS_SOURCE_DEADLINE_MS
              : DEEP_ANALYSIS_WORKER_DEADLINE_MS),
        ),
      );
    },
  );

  it("cannot claim the wrong phase or another owner's report", async () => {
    const report = makeReport();
    const { repository } = setup(report);
    await expect(
      repository.claimDeepAnalysisExecution(report.id, fingerprint, 'worker'),
    ).resolves.toBeNull();
    await expect(
      repository.claimDeepAnalysisExecution(
        report.id,
        otherFingerprint,
        'source',
      ),
    ).resolves.toBeNull();
    expect(report.status).toBe('QUEUED');
    expect(report.executionToken).toBeNull();
  });

  it('hands off source ownership exactly once and fences the old token after worker claim', async () => {
    const report = makeReport();
    const { repository } = setup(report);
    const sourceToken = await repository.claimDeepAnalysisExecution(
      report.id,
      fingerprint,
      'source',
    );
    expect(sourceToken).not.toBeNull();
    await repository.handoffDeepAnalysisExecution(
      report.id,
      fingerprint,
      sourceToken!,
      42,
    );

    expect(report).toMatchObject({
      status: 'QUEUED',
      stage: 'PREPROCESS',
      executionToken: null,
      executionDeadlineAt: null,
      memoryCount: 42,
      progressPercent: 10,
    });
    expect(report.leaseExpiresAt).toEqual(
      new Date(now.getTime() + DEEP_ANALYSIS_QUEUE_WAIT_MS),
    );
    const workerToken = await repository.claimDeepAnalysisExecution(
      report.id,
      fingerprint,
      'worker',
    );
    expect(workerToken).not.toBeNull();
    expect(workerToken).not.toBe(sourceToken);
    await expect(
      repository.renewDeepAnalysisExecution(
        report.id,
        fingerprint,
        sourceToken!,
      ),
    ).resolves.toBe(false);
    await expect(
      repository.updateDeepAnalysisExecution(
        report.id,
        fingerprint,
        sourceToken!,
        { status: 'FAILED' },
      ),
    ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
    await expect(
      repository.handoffDeepAnalysisExecution(
        report.id,
        fingerprint,
        sourceToken!,
        99,
      ),
    ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
    expect(report.executionToken).toBe(workerToken);
    expect(report.status).toBe('PREPARING');
  });

  it('does not let a worker lease perform a source handoff', async () => {
    const report = makeReport({ stage: 'PREPROCESS' });
    const { repository } = setup(report);
    const token = await repository.claimDeepAnalysisExecution(
      report.id,
      fingerprint,
      'worker',
    );
    await expect(
      repository.handoffDeepAnalysisExecution(
        report.id,
        fingerprint,
        token!,
        42,
      ),
    ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
    expect(report.executionToken).toBe(token);
  });

  it('keeps a live execution alive when renewal wins before the old expiry', async () => {
    const report = makeReport();
    const { repository } = setup(report);
    const token = await repository.claimDeepAnalysisExecution(
      report.id,
      fingerprint,
      'source',
    );
    const previousExpiry = report.leaseExpiresAt!;
    jest.setSystemTime(new Date(previousExpiry.getTime() - 1));
    await expect(
      repository.renewDeepAnalysisExecution(report.id, fingerprint, token!),
    ).resolves.toBe(true);
    jest.setSystemTime(previousExpiry);

    await expect(repository.expireStaleDeepAnalysisReports()).resolves.toBe(0);
    expect(report.status).toBe('PREPARING');
    expect(report.leaseExpiresAt!.getTime()).toBeGreaterThan(
      previousExpiry.getTime(),
    );
  });

  it('does not revive a report when the sweeper wins before a delayed renewal commits', async () => {
    const report = makeReport();
    const { repository, delayNextUpdate } = setup(report);
    const token = await repository.claimDeepAnalysisExecution(
      report.id,
      fingerprint,
      'source',
    );
    const expiry = report.leaseExpiresAt!;
    jest.setSystemTime(new Date(expiry.getTime() - 1));
    const release = delayNextUpdate();
    const renewal = repository.renewDeepAnalysisExecution(
      report.id,
      fingerprint,
      token!,
    );
    jest.setSystemTime(expiry);
    await expect(repository.expireStaleDeepAnalysisReports()).resolves.toBe(1);
    release();

    await expect(renewal).resolves.toBe(false);
    expect(report.status).toBe('FAILED');
    expect(report.executionToken).toBeNull();
    await expect(
      repository.updateDeepAnalysisExecution(report.id, fingerprint, token!, {
        status: 'COMPLETED',
        reportObjectKey: 'late-result',
      }),
    ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
    expect(report.reportObjectKey).toBeNull();
  });

  it('expires at the exact deadline and refuses to claim or renew expired work', async () => {
    const report = makeReport({ leaseExpiresAt: now });
    const { repository } = setup(report);
    await expect(
      repository.claimDeepAnalysisExecution(report.id, fingerprint, 'source'),
    ).resolves.toBeNull();
    await expect(repository.expireStaleDeepAnalysisReports()).resolves.toBe(1);
    await expect(repository.expireStaleDeepAnalysisReports()).resolves.toBe(0);
    expect(report).toMatchObject({
      status: 'FAILED',
      completedAt: now,
      errorCode: 'DEEP_ANALYSIS_INTERRUPTED',
      executionToken: null,
      leaseExpiresAt: null,
      executionDeadlineAt: null,
    });
    expect(report.requestedAt).toEqual(now);
    expect(report.requestDayKey).toBe('2026-10-28@UTC#dar_report');
  });

  it('enforces the hard execution deadline even if a heartbeat extended the lease', async () => {
    const report = makeReport({
      status: 'ANALYZING',
      stage: 'CHUNK_ANALYSIS',
      executionToken: 'old-token',
      executionDeadlineAt: now,
      leaseExpiresAt: new Date(now.getTime() + DEEP_ANALYSIS_LEASE_MS),
    });
    const { repository } = setup(report);
    await expect(
      repository.renewDeepAnalysisExecution(
        report.id,
        fingerprint,
        'old-token',
      ),
    ).resolves.toBe(false);
    await expect(
      repository.updateDeepAnalysisExecution(
        report.id,
        fingerprint,
        'old-token',
        { progressPercent: 99 },
      ),
    ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
    await expect(repository.expireStaleDeepAnalysisReports()).resolves.toBe(1);
    expect(report.progressPercent).toBe(0);
    expect(report.status).toBe('FAILED');
  });

  it('preserves pre-migration active rows that have no lease or hard deadline', async () => {
    const report = makeReport({
      requestedAt: new Date('2026-01-01T00:00:00Z'),
      startedAt: new Date('2026-01-01T00:00:00Z'),
      status: 'PREPARING',
      leaseExpiresAt: null,
      executionDeadlineAt: null,
    });
    const { repository } = setup(report);
    await expect(repository.expireStaleDeepAnalysisReports()).resolves.toBe(0);
    await expect(
      repository.claimDeepAnalysisExecution(report.id, fingerprint, 'source'),
    ).resolves.toBeNull();
    expect(report.status).toBe('PREPARING');
    expect(report.executionToken).toBeNull();
  });

  it.each(['FAILED', 'COMPLETED', 'deleted'] as const)(
    'does not let an old token revive %s work',
    async (state) => {
      const report = makeReport({
        status: state === 'deleted' ? 'PREPARING' : state,
        deletedAt: state === 'deleted' ? now : null,
        executionToken: 'old-token',
        executionDeadlineAt: new Date(
          now.getTime() + DEEP_ANALYSIS_SOURCE_DEADLINE_MS,
        ),
      });
      const { repository } = setup(report);
      await expect(
        repository.renewDeepAnalysisExecution(
          report.id,
          fingerprint,
          'old-token',
        ),
      ).resolves.toBe(false);
      await expect(
        repository.updateDeepAnalysisExecution(
          report.id,
          fingerprint,
          'old-token',
          { status: 'PREPARING', internalComment: 'resurrect' },
        ),
      ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
      await expect(
        repository.handoffDeepAnalysisExecution(
          report.id,
          fingerprint,
          'old-token',
          99,
        ),
      ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
      await expect(
        repository.expireStaleDeepAnalysisReports(
          new Date(now.getTime() + DEEP_ANALYSIS_SOURCE_DEADLINE_MS),
        ),
      ).resolves.toBe(0);
      expect(report.internalComment).toBeNull();
    },
  );

  it('rejects wrong-owner and superseded-token writes without changing the live report', async () => {
    const report = makeReport();
    const { repository } = setup(report);
    const token = await repository.claimDeepAnalysisExecution(
      report.id,
      fingerprint,
      'source',
    );
    for (const [owner, candidateToken] of [
      [otherFingerprint, token!],
      [fingerprint, 'superseded'],
    ] as const) {
      await expect(
        repository.renewDeepAnalysisExecution(report.id, owner, candidateToken),
      ).resolves.toBe(false);
      await expect(
        repository.updateDeepAnalysisExecution(
          report.id,
          owner,
          candidateToken,
          { status: 'FAILED' },
        ),
      ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
      await expect(
        repository.handoffDeepAnalysisExecution(
          report.id,
          owner,
          candidateToken,
          99,
        ),
      ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_LEASE_LOST' });
    }
    expect(report.status).toBe('PREPARING');
    expect(report.executionToken).toBe(token);
    expect(report.memoryCount).toBe(1);
  });

  it.each([
    ['FAILED', false],
    ['COMPLETED', false],
    ['FAILED', true],
    ['COMPLETED', true],
  ] as const)(
    'clears lease metadata for terminal %s with set-operation=%s',
    async (status, useSet) => {
      const report = makeReport();
      const { repository } = setup(report);
      const token = await repository.claimDeepAnalysisExecution(
        report.id,
        fingerprint,
        'source',
      );
      await repository.updateDeepAnalysisExecution(
        report.id,
        fingerprint,
        token!,
        {
          status: useSet ? { set: status } : status,
          completedAt: now,
        },
      );
      expect(report).toMatchObject({
        status,
        executionToken: null,
        leaseExpiresAt: null,
        executionDeadlineAt: null,
      });
      await expect(
        repository.renewDeepAnalysisExecution(report.id, fingerprint, token!),
      ).resolves.toBe(false);
    },
  );
});
