import { AnalysisRepository, AppError, createPrefixedId } from '@mem9/shared';
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs/operators';

import type { Mem9FastifyRequest } from './request-context';
import { resolveRequestId } from './request-id';

function auditInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number' || typeof value === 'string'
      ? Number(value)
      : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 2147483647
    ? parsed
    : null;
}

@Injectable()
export class RequestAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestAuditInterceptor.name);

  public constructor(private readonly repository: AnalysisRepository) {}

  public intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Mem9FastifyRequest>();
    const response = context
      .switchToHttp()
      .getResponse<{ statusCode: number }>();
    const startedAt = Date.now();
    let recorded = false;
    const record = (statusCode: number) => {
      if (recorded || request.mem9Context === undefined) return;
      recorded = true;
      const params = request.params as Record<string, unknown> | undefined;
      const data = {
        id: createPrefixedId('ram'),
        requestId: resolveRequestId(request.id),
        apiKeyFingerprint: new Uint8Array(
          request.mem9Context.apiKeyFingerprint,
        ),
        route: (
          request.routeOptions.url ??
          request.url.split('?')[0] ??
          ''
        ).slice(0, 255),
        jobId:
          typeof params?.jobId === 'string' ? params.jobId.slice(0, 64) : null,
        batchIndex: auditInteger(params?.batchIndex),
        memoryCount: auditInteger(
          (request.body as { memoryCount?: unknown } | undefined)?.memoryCount,
        ),
        statusCode,
        latencyMs: Date.now() - startedAt,
      };
      // Keep audit storage off the response path, but make persistence failure visible.
      void this.repository.recordAudit(data).catch(() => {
        this.logger.error(
          JSON.stringify({
            event: 'request_audit_write_failed',
            requestId: data.requestId,
            route: data.route,
            statusCode,
          }),
        );
      });
    };

    return next.handle().pipe(
      tap({
        complete: () => record(response.statusCode),
        error: (error: unknown) =>
          record(
            error instanceof AppError
              ? error.statusCode
              : error instanceof HttpException
                ? error.getStatus()
                : 500,
          ),
      }),
    );
  }
}
