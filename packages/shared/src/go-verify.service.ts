
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import { Inject, Injectable } from '@nestjs/common';

import { AppError } from './errors';

export type GoVerifyStatus = 'ACTIVE' | 'INACTIVE' | 'INVALID';

export interface GoVerifyResult {
  status: GoVerifyStatus;
  verifiedAt: Date;
}

// Never attach the raw error: anything derived from the request could carry the key.
function unavailable(reason: string, upstreamStatus?: number): AppError {
  return new AppError('API key verification is unavailable', {
    statusCode: 503,
    code: 'API_KEY_VERIFY_UNAVAILABLE',
    details: { reason, upstreamStatus },
  });
}

@Injectable()
export class GoVerifyService {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  public async verify(rawApiKey: string): Promise<GoVerifyResult> {
    if (this.config.goVerify.mode === 'noop') {
      return {
        status: 'ACTIVE',
        verifiedAt: new Date(),
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.goVerify.timeoutMs,
    );
    let response: Response;
    let body: unknown;

    try {
      try {
        response = await fetch(
          `${this.config.goVerify.baseUrl.replace(/\/+$/, '')}/v1alpha2/status`,
          {
            method: 'GET',
            headers: { 'X-API-Key': rawApiKey },
            // Do not forward the key to whatever a redirect points at.
            redirect: 'error',
            signal: controller.signal,
          },
        );
      } catch (error) {
        throw unavailable(error instanceof Error ? error.name : 'fetch_failed');
      }

      if ([400, 401, 403, 404].includes(response.status)) {
        return {
          status: 'INVALID',
          verifiedAt: new Date(),
        };
      }

      if (response.status !== 200) {
        throw unavailable('unexpected_status', response.status);
      }

      try {
        body = await response.json();
      } catch {
        throw unavailable('invalid_body');
      }
    } finally {
      clearTimeout(timeout);
    }

    const status =
      typeof body === 'object' && body !== null && 'status' in body
        ? (body as { status: unknown }).status
        : undefined;

    if (status !== 'active' && status !== 'inactive') {
      throw unavailable('unexpected_key_status');
    }

    return {
      status: status === 'active' ? 'ACTIVE' : 'INACTIVE',
      verifiedAt: new Date(),
    };
  }
}
