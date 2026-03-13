import { Injectable } from '@nestjs/common';
import type { RateLimitPolicy } from '@prisma/client';

import { AppError } from './errors';
import { redisKeys } from './redis-keys';
import { RedisService } from './redis.service';
import { dayWindow, minuteWindow, ttlUntilNextDay, ttlUntilNextMinute } from './time';

@Injectable()
export class RateLimitWindowService {
  public constructor(private readonly redis: RedisService) {}

  public async consume(
    fingerprintHex: string,
    policy: Pick<RateLimitPolicy, 'rpmLimit' | 'dailyLimit'>,
    cost: number,
    now = new Date(),
  ): Promise<void> {
    const minuteKey = redisKeys.rateLimitMinute(fingerprintHex, minuteWindow(now));
    const dayKey = redisKeys.rateLimitDay(fingerprintHex, dayWindow(now));
    const results = (await this.redis
      .multi()
      .incrby(minuteKey, cost)
      .expire(minuteKey, ttlUntilNextMinute(now))
      .incrby(dayKey, cost)
      .expire(dayKey, ttlUntilNextDay(now))
      .exec()) as [Error | null, number][] | null;
    const minuteCount = results?.[0]?.[1] ?? 0;
    const dayCount = results?.[2]?.[1] ?? 0;

    if (minuteCount > policy.rpmLimit || dayCount > policy.dailyLimit) {
      throw new AppError('Rate limit exceeded', {
        statusCode: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        details: {
          minuteCount,
          dayCount,
        },
      });
    }
  }
}
