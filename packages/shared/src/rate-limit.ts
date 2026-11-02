import { Injectable } from '@nestjs/common';
import type { RateLimitPolicy } from '@prisma/client';

import { AppError } from './errors';
import { redisKeys } from './redis-keys';
import { RedisService } from './redis.service';
import {
  dayWindow,
  minuteWindow,
  ttlUntilNextDay,
  ttlUntilNextMinute,
} from './time';

export interface RateLimitCost {
  minute: number;
  day: number;
}

@Injectable()
export class RateLimitWindowService {
  public constructor(private readonly redis: RedisService) {}

  public async consume(
    fingerprintHex: string,
    policy: Pick<RateLimitPolicy, 'rpmLimit' | 'dailyLimit'>,
    cost: number | RateLimitCost,
    now = new Date(),
  ): Promise<void> {
    const normalizedCost =
      typeof cost === 'number' ? { minute: cost, day: cost } : cost;
    const minuteKey = redisKeys.rateLimitMinute(
      fingerprintHex,
      minuteWindow(now),
    );
    const dayKey = redisKeys.rateLimitDay(fingerprintHex, dayWindow(now));
    const unavailable = () =>
      new AppError('Rate limiting is temporarily unavailable', {
        statusCode: 503,
        code: 'RATE_LIMIT_UNAVAILABLE',
      });
    let results: [Error | null, unknown][] | null;
    try {
      results = await this.redis
        .multi()
        .incrby(minuteKey, normalizedCost.minute)
        .expire(minuteKey, ttlUntilNextMinute(now))
        .incrby(dayKey, normalizedCost.day)
        .expire(dayKey, ttlUntilNextDay(now))
        .exec();
    } catch {
      throw unavailable();
    }
    // MULTI can resolve with per-command errors (for example OOM/WRONGTYPE).
    // A missing counter or failed TTL must never be treated as unused quota.
    if (
      results?.length !== 4 ||
      results.some(([error]) => error !== null)
    ) {
      throw unavailable();
    }
    const minuteCount = results[0]?.[1];
    const dayCount = results[2]?.[1];
    if (
      typeof minuteCount !== 'number' ||
      !Number.isSafeInteger(minuteCount) ||
      minuteCount < 0 ||
      typeof dayCount !== 'number' ||
      !Number.isSafeInteger(dayCount) ||
      dayCount < 0 ||
      results[1]?.[1] !== 1 ||
      results[3]?.[1] !== 1
    ) {
      throw unavailable();
    }

    if (minuteCount > policy.rpmLimit || dayCount > policy.dailyLimit) {
      const limit = dayCount > policy.dailyLimit ? 'day' : 'minute';
      throw new AppError('Rate limit exceeded', {
        statusCode: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        details: {
          minuteCount,
          dayCount,
          limit,
          retryAfterSeconds:
            limit === 'day' ? ttlUntilNextDay(now) : ttlUntilNextMinute(now),
        },
      });
    }
  }
}
