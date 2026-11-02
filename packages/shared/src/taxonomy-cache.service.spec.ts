import { TaxonomyCacheService } from './taxonomy-cache.service';

function setup() {
  const repository = {
    getTaxonomyRules: jest.fn().mockResolvedValue([]),
    getTaxonomyVersion: jest
      .fn()
      .mockResolvedValue({ version: 'v3', updatedAt: new Date() }),
  };
  const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  const service = new TaxonomyCacheService(
    repository as never,
    redis as never,
    { analysis: { taxonomyVersion: 'v3' } } as never,
  );
  return { service, repository, redis };
}

describe('taxonomy cache bounds', () => {
  it.each([
    '',
    'x'.repeat(33),
    'v3:injected',
    'v3\n',
    ['v3'],
    { version: 'v3' },
  ].map(version => [version]))('rejects malformed version %# before storage access', async (version) => {
    const { service, repository, redis } = setup();
    await expect(service.getResponse(version as string)).rejects.toMatchObject({
      code: 'INVALID_TAXONOMY_VERSION',
    });
    await expect(service.getRules(version as string)).rejects.toMatchObject({
      code: 'INVALID_TAXONOMY_VERSION',
    });
    expect(redis.get).not.toHaveBeenCalled();
    expect(repository.getTaxonomyVersion).not.toHaveBeenCalled();
    expect(repository.getTaxonomyRules).not.toHaveBeenCalled();
  });

  it('does not create cache entries for arbitrary non-existent versions', async () => {
    const { service, redis } = setup();
    for (let index = 0; index < 100; index++)
      await service.getRules(`unknown-${index}`);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('preserves default and explicit existing versions and cached results', async () => {
    const { service, repository, redis } = setup();
    const rule = {
      id: 'r1',
      version: 'v3',
      category: 'work',
      label: 'Work',
      lang: 'en',
      matchType: 'keyword',
      pattern: 'work',
      weight: 1,
      enabled: true,
    };
    repository.getTaxonomyRules.mockResolvedValue([rule]);
    expect(await service.getRules()).toEqual([rule]);
    expect(redis.set).toHaveBeenCalledWith(
      'taxonomy:v3',
      JSON.stringify([rule]),
      'EX',
      300,
    );
    redis.get.mockResolvedValue(JSON.stringify([rule]));
    expect(await service.getRules('v3')).toEqual([rule]);
    expect(repository.getTaxonomyRules).toHaveBeenCalledTimes(1);
  });
});
