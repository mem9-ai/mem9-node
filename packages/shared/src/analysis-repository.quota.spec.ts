import { Prisma } from '@prisma/client';

import { AnalysisRepository } from './analysis-repository';

const fingerprint = Buffer.alloc(32, 1);
const dbFingerprint = new Uint8Array(fingerprint);
const admissionTime = new Date('2026-10-28T00:00:00.000Z');
const activeStatuses = ['QUEUED', 'PREPARING', 'ANALYZING', 'SYNTHESIZING'];
const input = {
  fingerprint,
  lang: 'en',
  timezone: 'America/Los_Angeles',
  memoryCount: 1,
  sourceSnapshotObjectKey: 'source',
  enforceQuota: true,
  bypassDailyLimit: false,
};

function setup() {
  const tx = {
    $queryRaw: jest
      .fn<Promise<{ id: string }[]>, [Prisma.Sql]>()
      .mockResolvedValue([{ id: 'owner' }]),
    deepAnalysisReport: {
      findFirst: jest
        .fn<
          Promise<{ id: string } | null>,
          [Prisma.DeepAnalysisReportFindFirstArgs]
        >()
        .mockResolvedValue(null),
      count: jest
        .fn<Promise<number>, [Prisma.DeepAnalysisReportCountArgs]>()
        .mockResolvedValue(0),
      create: jest.fn(
        async (args: Prisma.DeepAnalysisReportCreateArgs) => args.data,
      ),
    },
  };
  const reports = {
    findMany: jest
      .fn<Promise<unknown[]>, [Prisma.DeepAnalysisReportFindManyArgs]>()
      .mockResolvedValue([]),
    findFirst: jest
      .fn<Promise<null>, [Prisma.DeepAnalysisReportFindFirstArgs]>()
      .mockResolvedValue(null),
    findUnique: jest
      .fn<Promise<null>, [Prisma.DeepAnalysisReportFindUniqueArgs]>()
      .mockResolvedValue(null),
    count: jest
      .fn<Promise<number>, [Prisma.DeepAnalysisReportCountArgs]>()
      .mockResolvedValue(0),
    update: jest
      .fn<Promise<void>, [Prisma.DeepAnalysisReportUpdateArgs]>()
      .mockResolvedValue(undefined),
    delete: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn(
      async (
        operation: ((value: typeof tx) => unknown) | Promise<unknown>[],
      ) =>
        typeof operation === 'function'
          ? operation(tx)
          : Promise.all(operation),
    ),
    deepAnalysisReport: reports,
  };
  return {
    tx,
    reports,
    prisma,
    repository: new AnalysisRepository(prisma as never),
  };
}

describe('deep analysis quota repository', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(admissionTime);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('looks up legacy timezone keys and deleted usage by UTC timestamp, plus active reports from any day', async () => {
    const { reports, repository } = setup();
    await repository.findDeepAnalysisQuotaReports(
      fingerprint,
      new Date('2026-10-28T23:59:59.999Z'),
    );

    const where = reports.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      apiKeyFingerprint: dbFingerprint,
      OR: [
        {
          requestedAt: {
            gte: admissionTime,
            lt: new Date('2026-10-29T00:00:00.000Z'),
          },
        },
        { status: { in: activeStatuses }, deletedAt: null },
      ],
    });
    // Neither old requestDayKey formats nor deletion can remove quota usage.
    expect(where).not.toHaveProperty('requestDayKey');
    expect(where).not.toHaveProperty('deletedAt');
  });

  it('locks the authenticated owner before reading quota or creating a report', async () => {
    const { tx, repository } = setup();
    let releaseOwner!: () => void;
    const lockAcquired = new Promise<{ id: string }[]>((resolve) => {
      releaseOwner = () => resolve([{ id: 'owner' }]);
    });
    tx.$queryRaw.mockReturnValue(lockAcquired);

    const creation = repository.createDeepAnalysisReport(input);
    expect(tx.deepAnalysisReport.findFirst).not.toHaveBeenCalled();
    expect(tx.deepAnalysisReport.count).not.toHaveBeenCalled();
    expect(tx.deepAnalysisReport.create).not.toHaveBeenCalled();

    releaseOwner();
    await creation;
    const lock = tx.$queryRaw.mock.calls[0]![0];
    expect(lock.sql).toContain('FOR UPDATE');
    expect(lock.sql).toContain('ApiKeySubject');
    expect(lock.sql).toContain("status = 'ACTIVE'");
    expect(lock.values).toContainEqual(dbFingerprint);
    expect(
      tx.deepAnalysisReport.findFirst.mock.calls[0]![0].where
        ?.apiKeyFingerprint,
    ).toEqual(dbFingerprint);
    expect(
      tx.deepAnalysisReport.count.mock.calls[0]![0].where?.apiKeyFingerprint,
    ).toEqual(dbFingerprint);
    expect(
      tx.deepAnalysisReport.create.mock.calls[0]![0].data.apiKeyFingerprint,
    ).toEqual(dbFingerprint);
  });

  it('does not read quota or create anything when the authenticated owner is missing or disabled', async () => {
    const { tx, repository } = setup();
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      repository.createDeepAnalysisReport(input),
    ).rejects.toMatchObject({ code: 'API_KEY_DISABLED' });
    expect(tx.deepAnalysisReport.findFirst).not.toHaveBeenCalled();
    expect(tx.deepAnalysisReport.count).not.toHaveBeenCalled();
    expect(tx.deepAnalysisReport.create).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rejects an active report from yesterday even when daily bypass is %s',
    async (bypassDailyLimit) => {
      const { tx, repository } = setup();
      tx.deepAnalysisReport.findFirst.mockResolvedValue({
        id: 'yesterday-running',
      });

      await expect(
        repository.createDeepAnalysisReport({ ...input, bypassDailyLimit }),
      ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_ALREADY_RUNNING' });
      expect(tx.deepAnalysisReport.findFirst.mock.calls[0]![0].where).toEqual({
        apiKeyFingerprint: dbFingerprint,
        status: { in: activeStatuses },
        deletedAt: null,
      });
      expect(tx.deepAnalysisReport.create).not.toHaveBeenCalled();
    },
  );

  it('does not let a deleted report with a stale running status permanently block admission', async () => {
    const { tx, repository } = setup();
    // A FAILED-report retry can race deletion and leave its tombstone PREPARING.
    tx.deepAnalysisReport.findFirst.mockImplementation(async ({ where }) =>
      where?.deletedAt === null ? null : { id: 'deleted-but-preparing' },
    );
    tx.deepAnalysisReport.count.mockResolvedValue(1);

    await repository.createDeepAnalysisReport(input);
    expect(
      tx.deepAnalysisReport.findFirst.mock.calls[0]![0].where,
    ).toHaveProperty('deletedAt', null);
    expect(
      tx.deepAnalysisReport.count.mock.calls[0]![0].where,
    ).not.toHaveProperty('deletedAt');
    expect(tx.deepAnalysisReport.create).toHaveBeenCalledTimes(1);
  });

  it('rejects the fourth UTC-day admission, including failed and deleted reports', async () => {
    const { tx, repository } = setup();
    tx.deepAnalysisReport.count.mockResolvedValue(3);

    await expect(
      repository.createDeepAnalysisReport(input),
    ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_DAILY_LIMIT' });
    expect(tx.deepAnalysisReport.count.mock.calls[0]![0].where).toEqual({
      apiKeyFingerprint: dbFingerprint,
      requestedAt: {
        gte: admissionTime,
        lt: new Date('2026-10-29T00:00:00.000Z'),
      },
    });
    expect(tx.deepAnalysisReport.create).not.toHaveBeenCalled();
  });

  it('allows an authorized daily bypass beyond three completed reports', async () => {
    const { tx, repository } = setup();
    tx.deepAnalysisReport.count.mockResolvedValue(3);

    await repository.createDeepAnalysisReport({
      ...input,
      bypassDailyLimit: true,
    });
    expect(tx.deepAnalysisReport.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.deepAnalysisReport.create).toHaveBeenCalledTimes(1);
  });

  it('uses one admission timestamp after a lock wait crosses midnight, even if the count finishes on another day', async () => {
    const { tx, repository } = setup();
    jest.setSystemTime(new Date('2026-10-27T23:59:59.999Z'));
    tx.$queryRaw.mockImplementation(async () => {
      jest.setSystemTime(admissionTime);
      return [{ id: 'owner' }];
    });
    tx.deepAnalysisReport.count.mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-10-29T00:00:00.000Z'));
      return 2;
    });

    await repository.createDeepAnalysisReport(input);
    const where = tx.deepAnalysisReport.count.mock.calls[0]![0].where;
    const data = tx.deepAnalysisReport.create.mock.calls[0]![0].data;
    expect(where?.requestedAt).toEqual({
      gte: admissionTime,
      lt: new Date('2026-10-29T00:00:00.000Z'),
    });
    expect(data.requestedAt).toEqual(admissionTime);
    expect(data.requestDayKey).toBe(`2026-10-28@UTC#${data.id}`);
    expect(data.timezone).toBe('America/Los_Angeles');
  });

  it('does not reuse count-based keys when old hard deletions left gaps', async () => {
    const { tx, repository } = setup();
    // Two legacy rows remain, but the third slot name is already occupied.
    const legacyKeys = ['2026-10-28@UTC', '2026-10-28@UTC#3'];
    tx.deepAnalysisReport.count.mockResolvedValue(legacyKeys.length);

    await repository.createDeepAnalysisReport(input);
    const data = tx.deepAnalysisReport.create.mock.calls[0]![0].data;
    expect(data.requestDayKey).toBe(`2026-10-28@UTC#${data.id}`);
    expect(legacyKeys).not.toContain(data.requestDayKey);
    expect(data.requestDayKey.length).toBeLessThanOrEqual(64);
  });

  it('keeps development admission unbounded while still requiring a real owner', async () => {
    const { tx, repository } = setup();
    await repository.createDeepAnalysisReport({
      ...input,
      enforceQuota: false,
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.deepAnalysisReport.findFirst).not.toHaveBeenCalled();
    expect(tx.deepAnalysisReport.count).not.toHaveBeenCalled();
    expect(tx.deepAnalysisReport.create).toHaveBeenCalledTimes(1);
  });
});

describe('deep analysis quota tombstones', () => {
  it('hides deleted reports from both list results and their total', async () => {
    const { reports, repository } = setup();
    await repository.listOwnedDeepAnalysisReports(fingerprint, 10, 0);

    const where = { apiKeyFingerprint: dbFingerprint, deletedAt: null };
    expect(reports.findMany.mock.calls[0]![0].where).toEqual(where);
    expect(reports.count.mock.calls[0]![0].where).toEqual(where);
  });

  it('does not expose a deleted or foreign-owned report through owner lookup', async () => {
    const { reports, repository } = setup();
    await expect(
      repository.getOwnedDeepAnalysisReport('foreign-or-deleted', fingerprint),
    ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_REPORT_NOT_FOUND' });

    expect(reports.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'foreign-or-deleted',
      apiKeyFingerprint: dbFingerprint,
      deletedAt: null,
    });
    expect(reports.update).not.toHaveBeenCalled();
  });

  it('hides deleted reports from the legacy day lookup', async () => {
    const { reports, repository } = setup();
    await repository.findDeepAnalysisReportByDay(fingerprint, '2026-10-28@UTC');
    expect(reports.findFirst.mock.calls[0]![0].where).toEqual({
      apiKeyFingerprint: dbFingerprint,
      requestDayKey: '2026-10-28@UTC',
      deletedAt: null,
    });
  });

  it('does not let internal cleanup read a deleted report', async () => {
    const { reports, repository } = setup();
    await expect(
      repository.getDeepAnalysisReport('deleted'),
    ).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_REPORT_NOT_FOUND' });
    expect(reports.findUnique.mock.calls[0]![0].where).toEqual({
      id: 'deleted',
      deletedAt: null,
    });
  });

  it('guards late worker and duplicate-cleanup writes against deleted reports', async () => {
    const { reports, repository } = setup();
    await repository.updateDeepAnalysisReport('deleted', {
      internalComment: 'late result',
    });
    expect(reports.update.mock.calls[0]![0]).toEqual({
      where: { id: 'deleted', deletedAt: null },
      data: { internalComment: 'late result' },
    });
  });

  it('retains the quota row while clearing stored content and sensitive errors', async () => {
    const { reports, repository } = setup();
    await repository.deleteDeepAnalysisReport('report');

    expect(reports.delete).not.toHaveBeenCalled();
    const { where, data } = reports.update.mock.calls[0]![0];
    expect(where).toEqual({ id: 'report', deletedAt: null });
    expect(data).toEqual({
      deletedAt: expect.any(Date),
      previewJson: Prisma.DbNull,
      internalComment: null,
      reportObjectKey: null,
      sourceSnapshotObjectKey: '',
      errorCode: null,
      errorMessage: null,
    });
    expect(data).not.toHaveProperty('requestedAt');
    expect(data).not.toHaveProperty('apiKeyFingerprint');
    expect(data).not.toHaveProperty('requestDayKey');
  });
});
