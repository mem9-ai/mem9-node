import {
  AnalysisRepository,
  AppError,
  GoVerifyService,
  RedisService,
  redisKeys,
} from '@mem9/shared';
import { Injectable } from '@nestjs/common';
import type { ApiKeySubject } from '@prisma/client';

export interface ApiKeyAuthenticationInput {
  rawApiKey: string;
  fingerprint: Buffer;
  fingerprintHex: string;
}

const ACTIVE_TTL_SECONDS = 300;
const NEGATIVE_TTL_SECONDS = 60;

@Injectable()
export class ApiKeyAuthService {
  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly goVerifyService: GoVerifyService,
    private readonly redis: RedisService,
  ) {}

  public async authenticate(
    input: ApiKeyAuthenticationInput,
  ): Promise<ApiKeySubject> {
    const subject = await this.repository.findApiKeySubject(input.fingerprint);

    if (subject !== null && subject.status !== 'ACTIVE') {
      throw new AppError('API key subject is not active', {
        statusCode: 403,
        code: 'API_KEY_DISABLED',
      });
    }

    const cacheKey = redisKeys.apiKeyVerification(input.fingerprintHex);
    const cached = await this.redis.get(cacheKey).catch(() => null);

    if (cached === 'invalid') {
      throw new AppError('Invalid API key', {
        statusCode: 401,
        code: 'API_KEY_INVALID',
      });
    }

    if (cached === 'inactive') {
      throw new AppError('Inactive API key', {
        statusCode: 403,
        code: 'API_KEY_INACTIVE',
      });
    }

    if (cached === 'active' && subject !== null) {
      await this.repository.markApiKeySubjectSeen(subject.id);
      return subject;
    }

    const result = await this.goVerifyService.verify(input.rawApiKey);

    if (result.status === 'INVALID') {
      await this.redis
        .set(cacheKey, 'invalid', 'EX', NEGATIVE_TTL_SECONDS)
        .catch(() => undefined);
      throw new AppError('Invalid API key', {
        statusCode: 401,
        code: 'API_KEY_INVALID',
      });
    }

    if (result.status === 'INACTIVE') {
      await this.redis
        .set(cacheKey, 'inactive', 'EX', NEGATIVE_TTL_SECONDS)
        .catch(() => undefined);
      throw new AppError('Inactive API key', {
        statusCode: 403,
        code: 'API_KEY_INACTIVE',
      });
    }

    const verifiedSubject = await this.repository.recordVerifiedApiKeySubject(
      input.fingerprint,
      result.verifiedAt,
    );

    if (verifiedSubject.status !== 'ACTIVE') {
      throw new AppError('API key subject is not active', {
        statusCode: 403,
        code: 'API_KEY_DISABLED',
      });
    }

    await this.redis
      .set(cacheKey, 'active', 'EX', ACTIVE_TTL_SECONDS)
      .catch(() => undefined);

    return verifiedSubject;
  }
}
