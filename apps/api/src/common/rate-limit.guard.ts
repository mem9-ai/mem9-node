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
    await this.rateLimitWindowService.consume(fingerprintHex, policy, this.resolveCost(request));
    return true;
  }

  private resolveCost(request: Mem9FastifyRequest): number | { minute: number; day: number } {
    const { method, url } = request;

    if (method === 'PUT' && url.includes('/batches/')) {
      return 3;
    }

    if (method === 'POST' && url.endsWith('/analysis-jobs/from-source')) {
      const expectedTotalBatches = this.readExpectedTotalBatches(request.body);
      return {
        minute: 2,
        day: 2 + expectedTotalBatches * 3,
      };
    }

    if (method === 'POST' && url.endsWith('/analysis-jobs')) {
      return 2;
    }

    return 1;
  }

  private readExpectedTotalBatches(body: unknown): number {
    if (!body || typeof body !== 'object' || !('expectedTotalBatches' in body)) {
      return 0;
    }

    const value = (body as { expectedTotalBatches?: unknown }).expectedTotalBatches;
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : 0;
  }
}
