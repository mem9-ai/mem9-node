export const redisKeys = {
  rateLimitMinute(fingerprintHex: string, minuteWindow: string): string {
    return `rl:${fingerprintHex}:m:${minuteWindow}`;
  },
  rateLimitDay(fingerprintHex: string, dayWindow: string): string {
    return `rl:${fingerprintHex}:d:${dayWindow}`;
  },
  jobProgress(jobId: string): string {
    return `aj:${jobId}:progress`;
  },
  aggregate(jobId: string): string {
    return `aj:${jobId}:aggregate`;
  },
  batchResult(jobId: string, batchIndex: number): string {
    return `aj:${jobId}:batch:${batchIndex}`;
  },
  events(jobId: string): string {
    return `aj:${jobId}:events`;
  },
  lock(jobId: string, batchIndex: number): string {
    return `lock:aj:${jobId}:batch:${batchIndex}`;
  },
  seenIds(jobId: string): string {
    return `aj:${jobId}:seen:ids`;
  },
  seenHashes(jobId: string): string {
    return `aj:${jobId}:seen:hashes`;
  },
  taxonomy(version: string): string {
    return `taxonomy:${version}`;
  },
  rateLimitPolicy(planCode: string): string {
    return `rlp:${planCode}`;
  },
  memoryAnalysisPeriodCache(
    fingerprintHex: string,
    periodKey: string,
    model: string,
    cacheVersion: string,
  ): string {
    return `ma:period:${fingerprintHex}:${periodKey}:${model}:${cacheVersion}`;
  },
  memoryAnalysisPeriodCacheIndex(fingerprintHex: string, periodKey: string): string {
    return `ma:period:index:${fingerprintHex}:${periodKey}`;
  },
};
