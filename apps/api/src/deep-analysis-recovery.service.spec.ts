import { DeepAnalysisRecoveryService } from './deep-analysis-recovery.service';

describe('deep analysis recovery scheduling', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runs at startup and every minute, then stops on shutdown', async () => {
    jest.useFakeTimers();
    const repository = {
      expireStaleDeepAnalysisReports: jest.fn().mockResolvedValue(0),
    };
    const service = new DeepAnalysisRecoveryService(repository as never);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(60000);
    expect(repository.expireStaleDeepAnalysisReports).toHaveBeenCalledTimes(2);
    service.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(120000);
    expect(repository.expireStaleDeepAnalysisReports).toHaveBeenCalledTimes(2);
  });

  it('avoids overlapping scans and permits a later scan after a database failure', async () => {
    let reject!: (error: Error) => void;
    const repository = {
      expireStaleDeepAnalysisReports: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_, fail) => {
              reject = fail;
            }),
        )
        .mockResolvedValue(0),
    };
    const service = new DeepAnalysisRecoveryService(repository as never);
    const first = service.runOnce();
    await expect(service.runOnce()).resolves.toBe(0);
    reject(new Error('database temporarily unavailable'));
    await expect(first).rejects.toThrow('database temporarily unavailable');
    await expect(service.runOnce()).resolves.toBe(0);
    expect(repository.expireStaleDeepAnalysisReports).toHaveBeenCalledTimes(2);
  });
});
