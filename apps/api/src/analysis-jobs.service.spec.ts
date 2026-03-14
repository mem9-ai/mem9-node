import { AnalysisJobsService, buildFacetStats } from './analysis-jobs.service';

describe('analysis jobs service', () => {
  it('exposes the service symbol for integration wiring', () => {
    expect(AnalysisJobsService).toBeDefined();
  });

  it('builds stable facet stats sorted by count desc then value asc and capped at 50', () => {
    const counts: Record<string, number> = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`term-${index.toString().padStart(2, '0')}`, 1] as const),
    );

    counts.priority = 53;
    counts.beta = 5;
    counts.alpha = 5;

    const stats = buildFacetStats(counts);

    expect(stats).toHaveLength(50);
    expect(stats[0]).toEqual({ value: 'priority', count: 53 });
    expect(stats[1]).toEqual({ value: 'alpha', count: 5 });
    expect(stats[2]).toEqual({ value: 'beta', count: 5 });
    expect(stats[3]).toEqual({ value: 'term-00', count: 1 });
    expect(stats[49]).toEqual({ value: 'term-46', count: 1 });
  });
});
