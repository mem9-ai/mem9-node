import { AppError, deriveApiKeyFingerprint, fingerprintToHex } from '@mem9/shared';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';


import type { Mem9FastifyRequest } from './request-context';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Mem9FastifyRequest>();
    const apiKeyHeader = request.headers['x-mem9-api-key'];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

    if (apiKey === undefined || apiKey.length === 0) {
      throw new AppError('Missing x-mem9-api-key header', {
        statusCode: 401,
        code: 'API_KEY_REQUIRED',
      });
    }

    const pepper = process.env.APP_PEPPER;

    if (pepper === undefined || pepper.length === 0) {
      throw new AppError('APP_PEPPER is not configured', {
        statusCode: 500,
        code: 'APP_PEPPER_NOT_CONFIGURED',
      });
    }

    const fingerprint = deriveApiKeyFingerprint(pepper, apiKey);
    request.mem9Context = {
      apiKeyFingerprint: fingerprint,
      apiKeyFingerprintHex: fingerprintToHex(fingerprint),
      requestId: request.id,
    };

    return true;
  }
}
