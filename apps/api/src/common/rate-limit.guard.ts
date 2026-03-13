import { AnalysisRepository, AppError, RateLimitWindowService } from '@mem9/shared';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';


import type { Mem9FastifyRequest } from './request-context';

@Injectable()
export class RateLimitGuard implements CanActivate {
  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly rateLimitWindowService: RateLimitWindowService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Mem9FastifyRequest>();
    const fingerprint = request.mem9Context?.apiKeyFingerprint;
    const fingerprintHex = request.mem9Context?.apiKeyFingerprintHex;

    if (fingerprint === undefined || fingerprintHex === undefined) {
      throw new AppError('Missing API key context', {
        statusCode: 401,
        code: 'API_KEY_REQUIRED',
      });
    }

    const subject = await this.repository.ensureApiKeySubject(fingerprint);
    const policy = await this.repository.getRateLimitPolicy(subject.planCode);
    await this.rateLimitWindowService.consume(fingerprintHex, policy, this.resolveCost(request.url, request.method));
    return true;
  }

  private resolveCost(url: string, method: string): number {
    if (method === 'PUT' && url.includes('/batches/')) {
      return 3;
    }

    if (method === 'POST' && url.endsWith('/analysis-jobs')) {
      return 2;
    }

    return 1;
  }
}
