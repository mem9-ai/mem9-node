import { AppError, deriveApiKeyFingerprint, fingerprintToHex } from '@mem9/shared';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';


import { ApiKeyAuthService } from './api-key-auth.service';
import type { Mem9FastifyRequest } from './request-context';

const API_KEY_PATTERN = /^[\x21-\x7E]{1,256}$/;

@Injectable()
export class ApiKeyGuard implements CanActivate {
  public constructor(private readonly apiKeyAuthService: ApiKeyAuthService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Mem9FastifyRequest>();
    const apiKeyHeader = request.headers['x-mem9-api-key'];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

    if (apiKey === undefined || apiKey.length === 0) {
      throw new AppError('Missing x-mem9-api-key header', {
        statusCode: 401,
        code: 'API_KEY_REQUIRED',
      });
    }

    if (!API_KEY_PATTERN.test(apiKey)) {
      throw new AppError('Invalid x-mem9-api-key header', {
        statusCode: 401,
        code: 'API_KEY_INVALID',
      });
    }

    const pepper = process.env.APP_PEPPER;

    if (pepper === undefined || pepper.length === 0) {
      throw new AppError('APP_PEPPER is not configured', {
        statusCode: 500,
        code: 'APP_PEPPER_NOT_CONFIGURED',
      });
    }

    const fingerprint: Buffer = deriveApiKeyFingerprint(pepper, apiKey);
    const fingerprintHex: string = fingerprintToHex(fingerprint);
    const subject = await this.apiKeyAuthService.authenticate({
      rawApiKey: apiKey,
      fingerprint,
      fingerprintHex,
    });

    request.mem9Context = {
      apiKeyFingerprint: fingerprint,
      apiKeyFingerprintHex: fingerprintHex,
      rawApiKey: apiKey,
      requestId: request.id,
    };
    request.mem9ApiKeySubject = subject;

    return true;
  }
}
