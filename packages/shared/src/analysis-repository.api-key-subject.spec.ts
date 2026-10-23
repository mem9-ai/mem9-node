import { AnalysisRepository } from './analysis-repository';
import { AppError } from './errors';

function createPrismaMock() {
  return {
    apiKeySubject: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
  };
}

const fingerprint = Buffer.alloc(32, 7);

describe('AnalysisRepository api key subjects', () => {
  it('no longer exposes the auto-provisioning ensureApiKeySubject', () => {
    const repository = new AnalysisRepository(createPrismaMock() as never);

    expect(
      (repository as unknown as Record<string, unknown>).ensureApiKeySubject,
    ).toBeUndefined();
  });

  it('findApiKeySubject is read-only and returns null for unseen fingerprints', async () => {
    const prisma = createPrismaMock();
    prisma.apiKeySubject.findUnique.mockResolvedValueOnce(null);
    const repository = new AnalysisRepository(prisma as never);

    await expect(repository.findApiKeySubject(fingerprint)).resolves.toBeNull();
    expect(prisma.apiKeySubject.create).not.toHaveBeenCalled();
    expect(prisma.apiKeySubject.upsert).not.toHaveBeenCalled();
    expect(prisma.apiKeySubject.update).not.toHaveBeenCalled();
  });

  it('recordVerifiedApiKeySubject creates ACTIVE rows but never overwrites status or plan on update', async () => {
    const prisma = createPrismaMock();
    const verifiedAt = new Date('2026-10-22T00:00:00.000Z');
    prisma.apiKeySubject.upsert.mockResolvedValueOnce({
      id: 'aks_1',
      status: 'DISABLED',
      planCode: 'pro',
    });
    const repository = new AnalysisRepository(prisma as never);

    const subject = await repository.recordVerifiedApiKeySubject(fingerprint, verifiedAt);

    // A locally revoked key must stay revoked even when upstream still says active.
    expect(subject.status).toBe('DISABLED');
    expect(prisma.apiKeySubject.upsert).toHaveBeenCalledTimes(1);
    const [firstCall] = prisma.apiKeySubject.upsert.mock.calls as unknown[][];
    const args = firstCall![0] as {
      where: { apiKeyFingerprint: Uint8Array };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(Buffer.from(args.where.apiKeyFingerprint).equals(fingerprint)).toBe(true);
    expect(args.create).toMatchObject({
      status: 'ACTIVE',
      planCode: 'default',
      lastVerifyAt: verifiedAt,
    });
    expect(Object.keys(args.update).sort()).toEqual(['lastSeenAt', 'lastVerifyAt']);
    expect(args.update.lastVerifyAt).toEqual(verifiedAt);
  });

  it('getActiveApiKeySubject never creates rows and rejects missing subjects', async () => {
    const prisma = createPrismaMock();
    prisma.apiKeySubject.findUnique.mockResolvedValueOnce(null);
    const repository = new AnalysisRepository(prisma as never);

    await expect(repository.getActiveApiKeySubject(fingerprint)).rejects.toMatchObject({
      statusCode: 401,
      code: 'API_KEY_REQUIRED',
    });
    expect(prisma.apiKeySubject.create).not.toHaveBeenCalled();
    expect(prisma.apiKeySubject.upsert).not.toHaveBeenCalled();
  });

  it.each(['DISABLED', 'PENDING'])(
    'getActiveApiKeySubject rejects %s subjects with 403',
    async (status) => {
      const prisma = createPrismaMock();
      prisma.apiKeySubject.findUnique.mockResolvedValueOnce({
        id: 'aks_1',
        status,
        planCode: 'default',
      });
      const repository = new AnalysisRepository(prisma as never);

      const error = await repository.getActiveApiKeySubject(fingerprint).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ statusCode: 403, code: 'API_KEY_DISABLED' });
    },
  );

  it('getActiveApiKeySubject returns ACTIVE subjects', async () => {
    const prisma = createPrismaMock();
    prisma.apiKeySubject.findUnique.mockResolvedValueOnce({
      id: 'aks_1',
      status: 'ACTIVE',
      planCode: 'default',
    });
    const repository = new AnalysisRepository(prisma as never);

    await expect(repository.getActiveApiKeySubject(fingerprint)).resolves.toMatchObject({
      id: 'aks_1',
      planCode: 'default',
    });
  });
});
