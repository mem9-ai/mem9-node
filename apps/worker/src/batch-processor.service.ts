import type { AnalysisBatchMessage, MemoryInput } from '@mem9/contracts';
import {
  AnalysisRepository,
  AppError,
  RedisProgressStore,
  RedisService,
  S3PayloadStorageService,
  TaxonomyCacheService,
  analyzeBatch,
  canonicalizeBatchPayload,
  createPrefixedId,
  gunzipJson,
  normalizeMemory,
  parseApiKeyFingerprint,
  sha256Hex,
} from '@mem9/shared';
import { Injectable, Logger } from '@nestjs/common';
import { AnalysisJobStatus, AnalysisJobBatchStatus } from '@prisma/client';


@Injectable()
export class BatchProcessorService {
  private readonly logger = new Logger(BatchProcessorService.name);
  private readonly progressStore: RedisProgressStore;

  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly redis: RedisService,
    private readonly storage: S3PayloadStorageService,
    private readonly taxonomyCache: TaxonomyCacheService,
  ) {
    this.progressStore = new RedisProgressStore(redis, 86400);
  }

  public async process(message: AnalysisBatchMessage, receiveCount: number): Promise<void> {
    // Queue bodies are untrusted JSON. Reject them before even acquiring a lock
    // or recording a failure against the job named in the message.
    if (!message || typeof message !== 'object' ||
        typeof message.jobId !== 'string' || message.jobId.length === 0 || message.jobId.length > 64 ||
        !Number.isSafeInteger(message.batchIndex) || message.batchIndex < 1 ||
        !Number.isSafeInteger(message.memoryCount) || message.memoryCount < 0 ||
        typeof message.payloadObjectKey !== 'string' ||
        typeof message.payloadHash !== 'string' || message.payloadHash.length !== 64 || !/^[a-f0-9]{64}$/.test(message.payloadHash)) {
      throw new AppError('Invalid batch message', { statusCode: 403, code: 'INVALID_BATCH_MESSAGE' });
    }
    const fingerprint = parseApiKeyFingerprint(message.apiKeyFingerprintHex);
    const loadOwnedBatch = async () => {
      const job = await this.repository.getOwnedJob(message.jobId, fingerprint);
      const batch = await this.repository.getBatch(job.id, message.batchIndex);
      if (batch?.jobId !== job.id || batch.batchIndex !== message.batchIndex ||
          batch.payloadObjectKey !== message.payloadObjectKey ||
          batch.payloadObjectKey !== `analysis-jobs/${job.id}/batches/${message.batchIndex}.json.gz` ||
          batch.payloadHash !== message.payloadHash || batch.memoryCount !== message.memoryCount) {
        throw new AppError('Queue message does not match uploaded batch', {
          statusCode: 403, code: 'INVALID_BATCH_MESSAGE',
        });
      }
      return { job, batch };
    };
    await loadOwnedBatch();

    const lockToken = createPrefixedId('lock');
    const lockAcquired = await this.progressStore.acquireLock(message.jobId, message.batchIndex, lockToken, 60);

    if (!lockAcquired) {
      this.logger.warn(`Skipped batch ${message.batchIndex} for job ${message.jobId}; lock is already held`);
      return;
    }

    try {
      // A different consumer may finish, or the job may be cancelled, while
      // this Redis acquisition is in flight. Never process the pre-lock snapshot.
      const { job, batch } = await loadOwnedBatch();
      try {
        if (job.status === AnalysisJobStatus.CANCELLED) {
          return;
        }

        if (batch.status === AnalysisJobBatchStatus.SUCCEEDED) {
          return;
        }

        if (await this.progressStore.hasBatchResult(message.jobId, message.batchIndex)) {
          await this.repository.markBatchSucceeded({
            jobId: message.jobId,
            batchIndex: message.batchIndex,
            processedMemories: batch.memoryCount,
            resultCacheKey: `aj:${message.jobId}:batch:${message.batchIndex}`,
            durationMs: 0,
            finalStatus:
              job.completedBatches + 1 >= job.expectedTotalBatches
                ? AnalysisJobStatus.COMPLETED
                : AnalysisJobStatus.PARTIAL,
          });
          return;
        }

        await this.progressStore.markBatchStarted(message.jobId, message.batchIndex);
        const startedAt = Date.now();
        await this.repository.markBatchRunning(message.jobId, message.batchIndex);

        const payloadBuffer = await this.storage.getObjectBuffer(batch.payloadObjectKey);
        const payload = gunzipJson<{
          jobId: string;
          batchIndex: number;
          memoryCount: number;
          memories: MemoryInput[];
        }>(payloadBuffer);
        if (payload?.jobId !== job.id || payload.batchIndex !== batch.batchIndex ||
            payload.memoryCount !== batch.memoryCount || !Array.isArray(payload.memories) ||
            payload.memories.length !== batch.memoryCount) {
          throw new AppError('Payload manifest validation failed', {
            statusCode: 422, code: 'INVALID_BATCH_PAYLOAD',
          });
        }
        const canonicalPayload = canonicalizeBatchPayload(payload.memoryCount, payload.memories);
        const computedHash = sha256Hex(canonicalPayload);

        if (computedHash !== batch.payloadHash) {
          throw new AppError('Payload hash validation failed', {
            statusCode: 422,
            code: 'PAYLOAD_HASH_VALIDATION_FAILED',
          });
        }

        const rules = await this.taxonomyCache.getRules(job.taxonomyVersion);
        const uniqueMemories = [];

        for (const memory of payload.memories.map(normalizeMemory)) {
          // Progress and category aggregates intentionally count unique memories only.
          if (await this.progressStore.markMemorySeen(message.jobId, memory.id, memory.contentHash)) {
            uniqueMemories.push(memory);
          }
        }

        const delta = analyzeBatch({
          batchIndex: message.batchIndex,
          memories: uniqueMemories,
          rules,
          lang: 'zh-CN',
        });
        const merged = await this.progressStore.mergeBatch(message.jobId, {
          ...delta,
          expectedTotalBatches: job.expectedTotalBatches,
        });
        const finalStatus =
          merged.progress.completedBatches >= job.expectedTotalBatches
            ? AnalysisJobStatus.COMPLETED
            : AnalysisJobStatus.PARTIAL;

        await this.repository.markBatchSucceeded({
          jobId: message.jobId,
          batchIndex: message.batchIndex,
          processedMemories: uniqueMemories.length,
          resultCacheKey: `aj:${message.jobId}:batch:${message.batchIndex}`,
          durationMs: Date.now() - startedAt,
          finalStatus,
        });
      } catch (error) {
        await this.repository.markBatchFailure({
          jobId: message.jobId,
          batchIndex: message.batchIndex,
          errorCode: error instanceof AppError ? error.code : 'BATCH_PROCESSING_FAILED',
          errorMessage: error instanceof Error ? error.message.slice(0, 512) : 'Batch processing failed',
          retryable: receiveCount < 3,
          receiveCount,
        });
        await this.progressStore.appendFailureEvent(
          message.jobId,
          message.batchIndex,
          error instanceof Error ? error.message : 'Batch processing failed',
        );
        throw error;
      }
    } finally {
      await this.progressStore.releaseLock(message.jobId, message.batchIndex, lockToken);
    }
  }
}
