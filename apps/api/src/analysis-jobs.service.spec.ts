import { AnalysisJobsService } from './analysis-jobs.service';

describe('analysis jobs service', () => {
  it('exposes the service symbol for integration wiring', () => {
    expect(AnalysisJobsService).toBeDefined();
  });
});
