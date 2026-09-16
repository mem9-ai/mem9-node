import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type {
  AggregateSnapshot,
  AnalysisFacetStat,
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
  compareCategoryPriority,
  GoVerifyService,
  RedisProgressStore,
  RedisService,
  RateLimitWindowService,
  S3PayloadStorageService,
  SqsQueueService,
  TaxonomyCacheService,
  canonicalizeBatchPayload,
  gzipJson,
  sha256Hex,
} from '@mem9/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AnalysisJobStatus } from '@prisma/client';

import type { Mem9RequestContext } from './common/request-context';
import type { CreateAnalysisJobDto } from './dto/create-analysis-job.dto';
import type { UploadAnalysisBatchDto } from './dto/upload-analysis-batch.dto';
import { Mem9SourceService } from './mem9-source.service';

const MAX_FACET_STATS = 50;
const SOURCE_BATCH_MINUTE_COST = 3;

function compareFacetValues(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function buildFacetStats(
  counts: Record<string, number>,
  limit = MAX_FACET_STATS,
): AnalysisFacetStat[] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || compareFacetValues(left[0], right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({
      value,
      count,
    }));
}

@Injectable()
export class AnalysisJobsService {
  private readonly logger = new Logger(AnalysisJobsService.name);
  private readonly progressStore: RedisProgressStore;

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly redis: RedisService,
    private readonly storage: S3PayloadStorageService,
    private readonly queue: SqsQueueService,
    private readonly taxonomyCacheService: TaxonomyCacheService,
    private readonly goVerifyService: GoVerifyService,
    private readonly source: Mem9SourceService,
    private readonly rateLimitWindowService: RateLimitWindowService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.progressStore = new RedisProgressStore(redis, config.analysis.jobResultTtlSeconds);
  }

  public async createJobFromSource(
    context: Mem9RequestContext,
    dto: CreateAnalysisJobDto,
  ): Promise<CreateAnalysisJobResponse> {
    const response = await this.createJob(context, dto);
    const schedule = typeof setImmediate === 'function'
      ? setImmediate
      : (callback: () => void) => setTimeout(callback, 0);

    schedule(() => {
      void this.prepareSourceJob(context, response.jobId, dto);
    });

    return response;
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
    const taxonomy = await this.taxonomyCacheService.getResponse(dto.options.taxonomyVersion);

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

    await this.progressStore.initializeJob(job.id, dto.expectedTotalBatches, taxonomy.categories);

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

    if (job.status === AnalysisJobStatus.CANCELLED) {
      throw new AppError('Analysis job was cancelled', {
        statusCode: 409,
        code: 'ANALYSIS_JOB_CANCELLED',
      });
    }

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
    const topTagStats = buildFacetStats(aggregate.tagCounts);
    const topTopicStats = buildFacetStats(aggregate.topicCounts);
    const topTags = topTagStats.map(({ value }) => value);
    const topTopics = topTopicStats.map(({ value }) => value);

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
      topTagStats,
      topTopicStats,
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
      .sort((left, right) => right.count - left.count || compareCategoryPriority(left.category, right.category));
  }

  private async prepareSourceJob(
    context: Mem9RequestContext,
    jobId: string,
    dto: CreateAnalysisJobDto,
  ): Promise<void> {
    try {
      const sourceMemories = await this.source.fetchAllMemories(context.rawApiKey);
      const job = await this.repository.getOwnedJob(
        jobId,
        context.apiKeyFingerprint,
      );

      if (job.status === AnalysisJobStatus.CANCELLED) {
        return;
      }

      const subject = await this.repository.ensureApiKeySubject(
        context.apiKeyFingerprint,
      );
      const policy = await this.repository.getRateLimitPolicy(subject.planCode);

      const rangeStart = Date.parse(dto.dateRange.start);
      const rangeEnd = Date.parse(dto.dateRange.end);
      const memories = sourceMemories.filter((memory) => {
        const createdAt = Date.parse(memory.createdAt);
        return Number.isFinite(createdAt) && createdAt >= rangeStart && createdAt <= rangeEnd;
      });
      const batches = Array.from(
        { length: Math.ceil(memories.length / dto.batchSize) },
        (_, index) => memories.slice(index * dto.batchSize, (index + 1) * dto.batchSize),
      );

      if (
        memories.length !== dto.expectedTotalMemories ||
        batches.length !== dto.expectedTotalBatches
      ) {
        throw new AppError('Analysis source changed while the job was starting', {
          statusCode: 409,
          code: 'ANALYSIS_SOURCE_CHANGED',
          details: {
            expectedTotalMemories: dto.expectedTotalMemories,
            actualTotalMemories: memories.length,
            expectedTotalBatches: dto.expectedTotalBatches,
            actualTotalBatches: batches.length,
          },
        });
      }

      for (const [offset, batch] of batches.entries()) {
        await this.consumeSourceBatchMinuteCost(
          context.apiKeyFingerprintHex,
          policy,
        );
        await this.uploadBatch(context, jobId, offset + 1, {
          memoryCount: batch.length,
          memories: batch.map((memory) => ({
            id: memory.id,
            content: memory.content,
            createdAt: memory.createdAt,
            metadata: memory.metadata ?? {},
          })),
        });
      }

      await this.finalizeJob(context, jobId);
    } catch (error) {
      const errorCode = error instanceof AppError
        ? error.code
        : 'ANALYSIS_SOURCE_PREPARATION_FAILED';
      const errorMessage = error instanceof Error
        ? error.message
        : 'Failed to prepare analysis source';

      const updated = await this.repository.markJobFailed(
        jobId,
        errorCode,
        errorMessage.slice(0, 512),
      );

      if (updated.status === AnalysisJobStatus.CANCELLED) {
        return;
      }

      this.logger.error(
        `Failed to prepare source-backed analysis job ${jobId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async consumeSourceBatchMinuteCost(
    fingerprintHex: string,
    policy: Parameters<RateLimitWindowService['consume']>[1],
  ): Promise<void> {
    while (true) {
      try {
        await this.rateLimitWindowService.consume(
          fingerprintHex,
          policy,
          { minute: SOURCE_BATCH_MINUTE_COST, day: 0 },
        );
        return;
      } catch (error) {
        const retryAfterSeconds = error instanceof AppError &&
          error.code === 'RATE_LIMIT_EXCEEDED' &&
          error.details?.limit === 'minute'
          ? Number(error.details.retryAfterSeconds)
          : Number.NaN;

        if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
          throw error;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, retryAfterSeconds * 1000 + 250);
        });
      }
    }
  }
}
