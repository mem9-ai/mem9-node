import {
  AnalysisRepository,
  AppError,
  S3PayloadStorageService,
  SqsQueueService,
  gzipJson,
  parseApiKeyFingerprint,
  withDeepAnalysisExecutionLease,
  isDeepAnalysisExecutionLeaseLost,
} from '@mem9/shared';
import { Injectable, Logger } from '@nestjs/common';
import {
  DeepAnalysisReportStage,
  DeepAnalysisReportStatus,
} from '@prisma/client';

import { Mem9SourceService } from './mem9-source.service';

interface PrepareSourceSnapshotInput {
  apiKeyFingerprintHex: string;
  reportId: string;
  sourceSnapshotObjectKey: string;
  rawApiKey: string;
  traceId: string;
}

@Injectable()
export class DeepAnalysisSourcePreparationService {
  private readonly logger = new Logger(
    DeepAnalysisSourcePreparationService.name,
  );

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly source: Mem9SourceService,
    private readonly storage: S3PayloadStorageService,
    private readonly queue: SqsQueueService,
  ) {}

  public schedule(input: PrepareSourceSnapshotInput): void {
    const schedule =
      typeof setImmediate === 'function'
        ? setImmediate
        : (callback: () => void) => setTimeout(callback, 0);

    schedule(() => {
      void this.prepareAndEnqueue(input).catch(() => {
        this.logger.error(
          JSON.stringify({
            event: 'deep_analysis_source_task_failed',
            reportId: input.reportId,
          }),
        );
      });
    });
  }

  public async prepareAndEnqueue(
    input: PrepareSourceSnapshotInput,
  ): Promise<void> {
    await withDeepAnalysisExecutionLease(
      this.repository,
      input.reportId,
      parseApiKeyFingerprint(input.apiKeyFingerprintHex),
      'source',
      async (lease) => {
        let handedOff = false;
        try {
          await lease.update({
            status: DeepAnalysisReportStatus.PREPARING,
            stage: DeepAnalysisReportStage.FETCH_SOURCE,
            progressPercent: 5,
            startedAt: new Date(),
            errorCode: null,
            errorMessage: null,
          });

          await lease.assertActive();
          const memories = await this.source.fetchAllMemories(input.rawApiKey);
          await lease.assertActive();
          await this.storage.putCompressedJson(
            input.sourceSnapshotObjectKey,
            gzipJson({
              fetchedAt: new Date().toISOString(),
              memoryCount: memories.length,
              memories,
            }),
          );

          // Publish readiness before sending. A fast worker can claim immediately;
          // source-side send failures must never overwrite that worker's state.
          await lease.handoff(memories.length);
          handedOff = true;

          await this.queue.enqueueLlmMessage({
            messageType: 'deep_report',
            apiKeyFingerprintHex: input.apiKeyFingerprintHex,
            reportId: input.reportId,
            traceId: input.traceId,
          });
        } catch (error) {
          if (isDeepAnalysisExecutionLeaseLost(error)) {
            throw error;
          }
          if (handedOff) {
            // SQS may have accepted an ambiguously failed send. Leave queued work
            // for the worker or the queue-wait expiry instead of retrying the model.
            this.logger.error(
              JSON.stringify({
                event: 'deep_analysis_enqueue_unconfirmed',
                reportId: input.reportId,
              }),
            );
            return;
          }
          const appError = error instanceof AppError ? error : null;
          const errorCode =
            appError?.code ?? 'DEEP_ANALYSIS_SOURCE_PREP_FAILED';
          const errorMessage =
            'Failed to prepare deep analysis source snapshot';

          this.logger.error(
            JSON.stringify({
              event: 'deep_analysis_source_failed',
              reportId: input.reportId,
              errorCode,
            }),
          );
          await lease.update({
            status: DeepAnalysisReportStatus.FAILED,
            stage: DeepAnalysisReportStage.FETCH_SOURCE,
            progressPercent: 0,
            completedAt: new Date(),
            errorCode,
            errorMessage: errorMessage.slice(0, 512),
          });
        }
      },
    );
  }
}
