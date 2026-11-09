import { AnalysisRepository } from './analysis-repository';

function setup() {
  const prisma = {
    // Keep the existing schema-initialization behavior out of these query tests.
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
    memoryReport: { update: jest.fn() },
  };
  return { prisma, repository: new AnalysisRepository(prisma as never) };
}

describe('memory report tenant isolation', () => {
  const owner = Buffer.alloc(32, 1);

  it.each(['running', 'success', 'fail'])(
    'includes the owner in the atomic %s update predicate',
    async (renderStatus) => {
      const { prisma, repository } = setup();
      prisma.memoryReport.update.mockResolvedValue({ reportId: 17, renderStatus });

      await repository.updateMemoryAnalysisReport(17, owner, { renderStatus });

      expect(prisma.memoryReport.update).toHaveBeenCalledTimes(1);
      expect(prisma.memoryReport.update).toHaveBeenCalledWith({
        where: { reportId: 17, apiKeyFingerprint: new Uint8Array(owner) },
        data: { renderStatus },
      });
    },
  );

  it('propagates an owner mismatch without retrying an unscoped update', async () => {
    const { prisma, repository } = setup();
    const notOwned = Object.assign(new Error('No record found for update'), { code: 'P2025' });
    prisma.memoryReport.update.mockRejectedValue(notOwned);

    await expect(repository.updateMemoryAnalysisReport(17, owner, {
      reportContent: 'must not reach another tenant',
    })).rejects.toBe(notOwned);

    expect(prisma.memoryReport.update).toHaveBeenCalledTimes(1);
    expect(prisma.memoryReport.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { reportId: 17, apiKeyFingerprint: new Uint8Array(owner) },
    }));
  });
});

describe('deep report tenant isolation', () => {
  const owner = Buffer.alloc(32, 1);
  const otherOwner = Buffer.alloc(32, 2);

  function setupDeepReport() {
    const row = { id: 'report', apiKeyFingerprint: new Uint8Array(owner), deletedAt: null as Date | null,
      internalComment: 'original' };
    interface Where { id?: string; apiKeyFingerprint?: Uint8Array; deletedAt?: null }
    const matches = (where: Where) =>
      where.id === row.id && row.deletedAt === null &&
      (where.apiKeyFingerprint === undefined || Buffer.from(where.apiKeyFingerprint).equals(owner));
    const reports = {
      findUnique: jest.fn(async ({ where }: { where: Where }) => matches(where) ? { ...row } : null),
      update: jest.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        if (!matches(where)) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        Object.assign(row, data);
        return { ...row };
      }),
    };
    return { row, reports, repository: new AnalysisRepository({ deepAnalysisReport: reports } as never) };
  }

  it('rejects another owner for reads, writes and soft deletion without changing the report', async () => {
    const { row, reports, repository } = setupDeepReport();
    await expect(repository.getDeepAnalysisReport('report', otherOwner))
      .rejects.toMatchObject({ code: 'DEEP_ANALYSIS_REPORT_NOT_FOUND' });
    await expect(repository.updateDeepAnalysisReport('report', otherOwner, { internalComment: 'changed' }))
      .rejects.toMatchObject({ code: 'P2025' });
    await expect(repository.deleteDeepAnalysisReport('report', otherOwner))
      .rejects.toMatchObject({ code: 'P2025' });
    expect(row.internalComment).toBe('original');
    expect(row.deletedAt).toBeNull();
    expect(reports.update).toHaveBeenCalledTimes(2);
  });

  it('preserves the valid owner workflow and prevents late writes after soft deletion', async () => {
    const { row, repository } = setupDeepReport();
    await expect(repository.getDeepAnalysisReport('report', owner)).resolves.toMatchObject({ id: 'report' });
    await repository.updateDeepAnalysisReport('report', owner, { internalComment: 'changed' });
    expect(row.internalComment).toBe('changed');
    await repository.deleteDeepAnalysisReport('report', owner);
    expect(row.deletedAt).toBeInstanceOf(Date);
    await expect(repository.updateDeepAnalysisReport('report', owner, { internalComment: 'late' }))
      .rejects.toMatchObject({ code: 'P2025' });
    expect(row.internalComment).toBeNull();
  });

  it('fails before querying when a runtime caller omits the owner', async () => {
    const { reports, repository } = setupDeepReport();
    const missingOwner = undefined as unknown as Buffer;
    await expect(repository.getDeepAnalysisReport('report', missingOwner)).rejects.toThrow();
    await expect(repository.updateDeepAnalysisReport('report', missingOwner, { internalComment: 'changed' }))
      .rejects.toThrow();
    await expect(repository.deleteDeepAnalysisReport('report', missingOwner)).rejects.toThrow();
    expect(reports.findUnique).not.toHaveBeenCalled();
    expect(reports.update).not.toHaveBeenCalled();
  });
});
