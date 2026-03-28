import {
  AnalysisRepository,
  AppError,
  S3PayloadStorageService,
  SqsQueueService,
  gzipJson,
} from '@mem9/shared';
import { Injectable, Logger } from '@nestjs/common';
import { DeepAnalysisReportStage, DeepAnalysisReportStatus } from '@prisma/client';

import { Mem9SourceService } from './mem9-source.service';

interface PrepareSourceSnapshotInput {
  reportId: string;
  sourceSnapshotObjectKey: string;
  rawApiKey: string;
  traceId: string;
}

@Injectable()
export class DeepAnalysisSourcePreparationService {
  private readonly logger = new Logger(DeepAnalysisSourcePreparationService.name);

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly source: Mem9SourceService,
    private readonly storage: S3PayloadStorageService,
    private readonly queue: SqsQueueService,
  ) {}

  public schedule(input: PrepareSourceSnapshotInput): void {
    const schedule = typeof setImmediate === 'function'
      ? setImmediate
      : (callback: () => void) => setTimeout(callback, 0);

    schedule(() => {
      void this.prepareAndEnqueue(input);
    });
  }

  public async prepareAndEnqueue(input: PrepareSourceSnapshotInput): Promise<void> {
    try {
      await this.repository.updateDeepAnalysisReport(input.reportId, {
        status: DeepAnalysisReportStatus.PREPARING,
        stage: DeepAnalysisReportStage.FETCH_SOURCE,
        progressPercent: 5,
        startedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      });

      const memories = await this.source.fetchAllMemories(input.rawApiKey);
      await this.storage.putCompressedJson(
        input.sourceSnapshotObjectKey,
        gzipJson({
          fetchedAt: new Date().toISOString(),
          memoryCount: memories.length,
          memories,
        }),
      );

      await this.repository.updateDeepAnalysisReport(input.reportId, {
        memoryCount: memories.length,
        progressPercent: 10,
      });

      await this.queue.enqueueLlmMessage({
        messageType: 'deep_report',
        reportId: input.reportId,
        traceId: input.traceId,
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      const errorCode = appError?.code ?? 'DEEP_ANALYSIS_SOURCE_PREP_FAILED';
      const errorMessage = appError?.message ?? 'Failed to prepare deep analysis source snapshot';

      this.logger.error(
        `Failed to prepare deep analysis source snapshot for ${input.reportId}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.repository.updateDeepAnalysisReport(input.reportId, {
        status: DeepAnalysisReportStatus.FAILED,
        stage: DeepAnalysisReportStage.FETCH_SOURCE,
        progressPercent: 0,
        completedAt: new Date(),
        errorCode,
        errorMessage: errorMessage.slice(0, 512),
      });
    }
  }
}
