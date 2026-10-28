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
