import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type {
  AggregateSnapshot,
  AnalysisJobSnapshotResponse,
  AnalysisJobUpdatesResponse,
  BatchSummary,
  CancelAnalysisJobResponse,
  CreateAnalysisJobResponse,
  FinalizeAnalysisJobResponse,
} from '@mem9/contracts';
import {
  AnalysisRepository,
  AppError,
  GoVerifyService,
  RedisProgressStore,
  RedisService,
  S3PayloadStorageService,
  SqsQueueService,
  TaxonomyCacheService,
  canonicalizeBatchPayload,
  gzipJson,
  sha256Hex,
} from '@mem9/shared';
import { Inject, Injectable } from '@nestjs/common';

import type { Mem9RequestContext } from './common/request-context';
import type { CreateAnalysisJobDto } from './dto/create-analysis-job.dto';
import type { UploadAnalysisBatchDto } from './dto/upload-analysis-batch.dto';

@Injectable()
export class AnalysisJobsService {
  private readonly progressStore: RedisProgressStore;

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly redis: RedisService,
    private readonly storage: S3PayloadStorageService,
    private readonly queue: SqsQueueService,
    private readonly taxonomyCacheService: TaxonomyCacheService,
    private readonly goVerifyService: GoVerifyService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.progressStore = new RedisProgressStore(redis, config.analysis.jobResultTtlSeconds);
  }

  public async createJob(
    context: Mem9RequestContext,
    dto: CreateAnalysisJobDto,
  ): Promise<CreateAnalysisJobResponse> {
    const subject = await this.repository.ensureApiKeySubject(context.apiKeyFingerprint);
    const policy = await this.repository.getRateLimitPolicy(subject.planCode);

    if (dto.expectedTotalBatches > policy.maxBatchesPerJob) {
      throw new AppError('Expected batches exceed plan limit', {
        statusCode: 422,
        code: 'MAX_BATCHES_EXCEEDED',
      });
    }

    const activeJobs = await this.repository.countActiveJobs(context.apiKeyFingerprint);

    if (activeJobs >= policy.maxActiveJobs) {
      throw new AppError('Too many active jobs', {
        statusCode: 429,
        code: 'MAX_ACTIVE_JOBS_EXCEEDED',
      });
    }

    await this.goVerifyService.verify();

    const pipelineConfig = await this.repository.getPipelineConfig(this.config.analysis.pipelineVersion);

    if (dto.batchSize > pipelineConfig.defaultBatchSize && dto.batchSize > this.config.analysis.maxBatchMemories) {
      throw new AppError('Batch size exceeds allowed maximum', {
        statusCode: 422,
        code: 'BATCH_SIZE_EXCEEDED',
      });
    }

    const expiresAt = new Date(Date.now() + this.config.analysis.jobResultTtlSeconds * 1000);
    const job = await this.repository.createJob({
      fingerprint: context.apiKeyFingerprint,
      dateRangeStart: new Date(dto.dateRange.start),
      dateRangeEnd: new Date(dto.dateRange.end),
      expectedTotalMemories: dto.expectedTotalMemories,
      expectedTotalBatches: dto.expectedTotalBatches,
      batchSize: dto.batchSize,
      pipelineVersion: this.config.analysis.pipelineVersion,
      taxonomyVersion: dto.options.taxonomyVersion,
      llmEnabled: dto.options.llmEnabled,
      expiresAt,
    });

    await this.progressStore.initializeJob(job.id, dto.expectedTotalBatches);

    return {
      jobId: job.id,
      status: job.status,
      expectedTotalBatches: job.expectedTotalBatches,
      uploadConcurrency: 3,
      pollAfterMs: 1500,
    };
  }

  public async uploadBatch(
    context: Mem9RequestContext,
    jobId: string,
    batchIndex: number,
    dto: UploadAnalysisBatchDto,
  ) {
    const job = await this.repository.getOwnedJob(jobId, context.apiKeyFingerprint);

    if (batchIndex < 1 || batchIndex > job.expectedTotalBatches) {
      throw new AppError('Batch index is out of range', {
        statusCode: 422,
        code: 'BATCH_INDEX_OUT_OF_RANGE',
      });
    }

    if (dto.memoryCount !== dto.memories.length) {
      throw new AppError('memoryCount must match memories length', {
        statusCode: 422,
        code: 'MEMORY_COUNT_MISMATCH',
      });
    }

    if (dto.memoryCount > this.config.analysis.maxBatchMemories) {
      throw new AppError('Batch memory count exceeds the configured maximum', {
        statusCode: 422,
        code: 'MAX_BATCH_MEMORIES_EXCEEDED',
      });
    }

    const canonicalPayload = canonicalizeBatchPayload(dto.memoryCount, dto.memories);
    const payloadBytes = Buffer.byteLength(canonicalPayload);

    if (payloadBytes > this.config.analysis.maxBatchBytes) {
      throw new AppError('Batch body exceeds the configured byte limit', {
        statusCode: 413,
        code: 'MAX_BATCH_BYTES_EXCEEDED',
      });
    }

    const payloadHash = sha256Hex(canonicalPayload);

    if (dto.batchHash !== undefined && dto.batchHash !== payloadHash) {
      throw new AppError('Provided batchHash does not match the payload hash', {
        statusCode: 422,
        code: 'BATCH_HASH_VALIDATION_FAILED',
      });
    }

    const payloadObjectKey = `analysis-jobs/${job.id}/batches/${batchIndex}.json.gz`;
    const gzipped = gzipJson({
      jobId,
      batchIndex,
      memoryCount: dto.memoryCount,
      memories: dto.memories,
    });

    await this.storage.putCompressedJson(payloadObjectKey, gzipped);
    const { batch } = await this.repository.upsertUploadedBatch({
      jobId,
      batchIndex,
      memoryCount: dto.memoryCount,
      payloadHash,
      payloadObjectKey,
    });
    await this.queue.enqueueBatch({
      jobId,
      batchIndex,
      payloadObjectKey,
      payloadHash,
      memoryCount: dto.memoryCount,
      pipelineVersion: job.pipelineVersion,
      taxonomyVersion: job.taxonomyVersion,
      llmEnabled: job.llmEnabled,
      traceId: context.requestId,
    });
    await this.progressStore.markBatchUploaded(jobId, batchIndex, job.expectedTotalBatches);

    return {
      jobId,
      batchIndex,
      status: batch.status,
      payloadObjectKey,
      payloadHash,
      queuedAt: new Date().toISOString(),
    };
  }

  public async finalizeJob(
    context: Mem9RequestContext,
    jobId: string,
  ): Promise<FinalizeAnalysisJobResponse> {
    const job = await this.repository.getOwnedJob(jobId, context.apiKeyFingerprint);
    const updated = await this.repository.markJobFinalized(job.id);

    return {
      jobId: updated.id,
      status: updated.status,
      uploadedBatches: updated.uploadedBatches,
      expectedTotalBatches: updated.expectedTotalBatches,
    };
  }

  public async cancelJob(
    context: Mem9RequestContext,
    jobId: string,
  ): Promise<CancelAnalysisJobResponse> {
    const job = await this.repository.getOwnedJob(jobId, context.apiKeyFingerprint);
    const updated = await this.repository.cancelJob(job.id);

    return {
      jobId: updated.id,
      status: updated.status,
    };
  }

  public async getSnapshot(
    context: Mem9RequestContext,
    jobId: string,
  ): Promise<AnalysisJobSnapshotResponse> {
    const [job, progress, aggregate] = await Promise.all([
      this.repository.getOwnedJob(jobId, context.apiKeyFingerprint),
      this.progressStore.getProgress(jobId),
      this.progressStore.getAggregate(jobId),
    ]);
    const batchSummaries = await Promise.all(
      job.batches.map(async (batch): Promise<BatchSummary> => {
        const cached = await this.progressStore.getBatchResult(jobId, batch.batchIndex);

        if (cached !== null) {
          return {
            ...cached,
            status: batch.status,
            startedAt: batch.startedAt?.toISOString(),
            completedAt: batch.completedAt?.toISOString(),
            errorCode: batch.errorCode,
            errorMessage: batch.errorMessage,
          };
        }

        return {
          batchIndex: batch.batchIndex,
          status: batch.status,
          memoryCount: batch.memoryCount,
          processedMemories: batch.status === 'SUCCEEDED' ? batch.memoryCount : 0,
          topCategories: [],
          topTags: [],
          startedAt: batch.startedAt?.toISOString(),
          completedAt: batch.completedAt?.toISOString(),
          errorCode: batch.errorCode,
          errorMessage: batch.errorMessage,
        };
      }),
    );
    const aggregateCards = this.mapAggregateCards(aggregate, progress.processedMemories);
    const topTags = Object.entries(aggregate.tagCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([tag]) => tag);
    const topTopics = Object.entries(aggregate.topicCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([tag]) => tag);

    return {
      jobId: job.id,
      status: job.status,
      expectedTotalMemories: job.expectedTotalMemories,
      expectedTotalBatches: job.expectedTotalBatches,
      batchSize: job.batchSize,
      pipelineVersion: job.pipelineVersion,
      taxonomyVersion: job.taxonomyVersion,
      llmEnabled: job.llmEnabled,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      progress: {
        ...progress,
        uploadedBatches: Math.max(progress.uploadedBatches, job.uploadedBatches),
        completedBatches: Math.max(progress.completedBatches, job.completedBatches),
        failedBatches: Math.max(progress.failedBatches, job.failedBatches),
        processedMemories: Math.max(progress.processedMemories, job.processedMemories),
        expectedTotalBatches: job.expectedTotalBatches,
      },
      aggregate,
      aggregateCards,
      topTags,
      topTopics,
      batchSummaries,
    };
  }

  public async getUpdates(
    context: Mem9RequestContext,
    jobId: string,
    cursor: number,
  ): Promise<AnalysisJobUpdatesResponse> {
    await this.repository.getOwnedJob(jobId, context.apiKeyFingerprint);
    return this.progressStore.getUpdates(jobId, cursor);
  }

  public async getTaxonomy(version?: string) {
    return this.taxonomyCacheService.getResponse(version);
  }

  private mapAggregateCards(aggregate: AggregateSnapshot, processedMemories: number) {
    return Object.entries(aggregate.categoryCounts)
      .map(([category, count]) => ({
        category: category as keyof AggregateSnapshot['categoryCounts'],
        count,
        confidence: processedMemories === 0 ? 0 : Number((count / processedMemories).toFixed(2)),
      }))
      .sort((left, right) => right.count - left.count);
  }
}
