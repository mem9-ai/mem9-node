import { AnalysisRepository, createPrefixedId } from '@mem9/shared';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs/operators';


import type { Mem9FastifyRequest } from './request-context';

@Injectable()
export class RequestAuditInterceptor implements NestInterceptor {
  public constructor(private readonly repository: AnalysisRepository) {}

  public intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Mem9FastifyRequest>();
    const response = context.switchToHttp().getResponse<{ statusCode: number }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: async () => {
          if (request.mem9Context === undefined) {
            return;
          }

          try {
            await this.repository.recordAudit({
              id: createPrefixedId('ram'),
              requestId: request.id,
              apiKeyFingerprint: new Uint8Array(
                request.mem9Context.apiKeyFingerprint.buffer.slice(
                  request.mem9Context.apiKeyFingerprint.byteOffset,
                  request.mem9Context.apiKeyFingerprint.byteOffset +
                    request.mem9Context.apiKeyFingerprint.byteLength,
                ) as ArrayBuffer,
              ),
              route: request.routeOptions.url ?? request.url,
              jobId: (request.params as Record<string, string> | undefined)?.jobId,
              batchIndex: Number((request.params as Record<string, string> | undefined)?.batchIndex ?? 0) || null,
              memoryCount: Number((request.body as { memoryCount?: number } | undefined)?.memoryCount ?? 0) || null,
              statusCode: response.statusCode,
              latencyMs: Date.now() - startedAt,
            });
          } catch {
            // Audit failures must not affect the request path.
          }
        },
      }),
    );
  }
}
