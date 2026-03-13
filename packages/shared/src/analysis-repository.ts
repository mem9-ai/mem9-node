import { Injectable } from '@nestjs/common';
import type {
  AnalysisJob,
  AnalysisJobBatch,
  ApiKeySubject,
  Prisma,
  RateLimitPolicy,
  TaxonomyRule,
} from '@prisma/client';
import { AnalysisJobBatchStatus, AnalysisJobStatus, ApiKeySubjectStatus } from '@prisma/client';

import { AppError } from './errors';
import { createPrefixedId } from './ids';
import { PrismaService } from './prisma.service';

type AnalysisJobWithBatches = Prisma.AnalysisJobGetPayload<{
  include: {
    batches: true;
  };
}>;

function toPrismaBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  const arrayBuffer = value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;

  return new Uint8Array(arrayBuffer);
}

@Injectable()
export class AnalysisRepository {
  public constructor(private readonly prisma: PrismaService) {}

  public async ensureApiKeySubject(fingerprint: Buffer): Promise<ApiKeySubject> {
    const existing = await this.prisma.apiKeySubject.findUnique({
      where: { apiKeyFingerprint: toPrismaBytes(fingerprint) },
    });

    if (existing !== null) {
      return this.prisma.apiKeySubject.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
        },
      });
    }

    return this.prisma.apiKeySubject.create({
      data: {
        id: createPrefixedId('aks'),
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        status: ApiKeySubjectStatus.ACTIVE,
        planCode: 'default',
        lastSeenAt: new Date(),
      },
    });
  }

  public async getRateLimitPolicy(planCode: string): Promise<RateLimitPolicy> {
    const policy = await this.prisma.rateLimitPolicy.findUnique({
      where: { planCode },
    });

    if (!policy?.enabled) {
      throw new AppError('Rate limit policy not found', {
        statusCode: 429,
        code: 'RATE_LIMIT_POLICY_NOT_FOUND',
      });
    }

    return policy;
  }

  public async getPipelineConfig(version: string) {
    const config = await this.prisma.analysisPipelineConfig.findUnique({
      where: { version },
    });

    if (config === null) {
      throw new AppError('Pipeline config not found', {
        statusCode: 500,
        code: 'PIPELINE_CONFIG_NOT_FOUND',
      });
    }

    return config;
  }

  public async getTaxonomyRules(version: string): Promise<TaxonomyRule[]> {
    return this.prisma.taxonomyRule.findMany({
      where: {
        version,
        enabled: true,
      },
      orderBy: {
        weight: 'desc',
      },
    });
  }

  public async countActiveJobs(fingerprint: Buffer): Promise<number> {
    return this.prisma.analysisJob.count({
      where: {
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        status: {
          in: [AnalysisJobStatus.UPLOADING, AnalysisJobStatus.PROCESSING, AnalysisJobStatus.PARTIAL],
        },
      },
    });
  }

  public async createJob(data: {
    fingerprint: Buffer;
    dateRangeStart: Date;
    dateRangeEnd: Date;
    expectedTotalMemories: number;
    expectedTotalBatches: number;
    batchSize: number;
    pipelineVersion: string;
    taxonomyVersion: string;
    llmEnabled: boolean;
    expiresAt: Date;
  }): Promise<AnalysisJob> {
    return this.prisma.analysisJob.create({
      data: {
        id: createPrefixedId('aj'),
        apiKeyFingerprint: toPrismaBytes(data.fingerprint),
        status: AnalysisJobStatus.UPLOADING,
        dateRangeStart: data.dateRangeStart,
        dateRangeEnd: data.dateRangeEnd,
        expectedTotalMemories: data.expectedTotalMemories,
        expectedTotalBatches: data.expectedTotalBatches,
        batchSize: data.batchSize,
        pipelineVersion: data.pipelineVersion,
        taxonomyVersion: data.taxonomyVersion,
        llmEnabled: data.llmEnabled,
        expiresAt: data.expiresAt,
      },
    });
  }

  public async getOwnedJob(jobId: string, fingerprint: Buffer): Promise<AnalysisJobWithBatches> {
    const job = await this.prisma.analysisJob.findFirst({
      where: {
        id: jobId,
        apiKeyFingerprint: toPrismaBytes(fingerprint),
      },
      include: {
        batches: {
          orderBy: {
            batchIndex: 'asc',
          },
        },
      },
    });

    if (job === null) {
      throw new AppError('Analysis job not found', {
        statusCode: 404,
        code: 'ANALYSIS_JOB_NOT_FOUND',
      });
    }

    return job as AnalysisJobWithBatches;
  }

  public async getJob(jobId: string): Promise<AnalysisJobWithBatches> {
    const job = await this.prisma.analysisJob.findUnique({
      where: { id: jobId },
      include: {
        batches: true,
      },
    });

    if (job === null) {
      throw new AppError('Analysis job not found', {
        statusCode: 404,
        code: 'ANALYSIS_JOB_NOT_FOUND',
      });
    }

    return job as AnalysisJobWithBatches;
  }

  public async getBatch(jobId: string, batchIndex: number): Promise<AnalysisJobBatch | null> {
    return this.prisma.analysisJobBatch.findUnique({
      where: {
        jobId_batchIndex: {
          jobId,
          batchIndex,
        },
      },
    });
  }

  public async upsertUploadedBatch(data: {
    jobId: string;
    batchIndex: number;
    memoryCount: number;
    payloadHash: string;
    payloadObjectKey: string;
  }): Promise<{ batch: AnalysisJobBatch; isNewUpload: boolean }> {
    const existing = await this.getBatch(data.jobId, data.batchIndex);

    if (existing !== null) {
      if (existing.payloadHash !== data.payloadHash) {
        throw new AppError('Batch already uploaded with a different hash', {
          statusCode: 409,
          code: 'BATCH_HASH_MISMATCH',
        });
      }

      const batch = await this.prisma.analysisJobBatch.update({
        where: {
          id: existing.id,
        },
        data: {
          status: AnalysisJobBatchStatus.QUEUED,
          payloadObjectKey: data.payloadObjectKey,
          memoryCount: data.memoryCount,
        },
      });

      return { batch, isNewUpload: false };
    }

    const batch = await this.prisma.analysisJobBatch.create({
      data: {
        id: createPrefixedId('ajb'),
        jobId: data.jobId,
        batchIndex: data.batchIndex,
        status: AnalysisJobBatchStatus.QUEUED,
        memoryCount: data.memoryCount,
        payloadHash: data.payloadHash,
        payloadObjectKey: data.payloadObjectKey,
      },
    });

    await this.prisma.analysisJob.update({
      where: { id: data.jobId },
      data: {
        uploadedBatches: {
          increment: 1,
        },
      },
    });

    return { batch, isNewUpload: true };
  }

  public async markJobFinalized(jobId: string): Promise<AnalysisJob> {
    return this.prisma.analysisJob.update({
      where: { id: jobId },
      data: {
        status: AnalysisJobStatus.PROCESSING,
        startedAt: new Date(),
      },
    });
  }

  public async cancelJob(jobId: string): Promise<AnalysisJob> {
    return this.prisma.analysisJob.update({
      where: { id: jobId },
      data: {
        status: AnalysisJobStatus.CANCELLED,
      },
    });
  }

  public async markBatchRunning(jobId: string, batchIndex: number): Promise<AnalysisJobBatch> {
    const batch = await this.getBatch(jobId, batchIndex);

    if (batch === null) {
      throw new AppError('Analysis batch not found', {
        statusCode: 404,
        code: 'ANALYSIS_BATCH_NOT_FOUND',
      });
    }

    return this.prisma.analysisJobBatch.update({
      where: { id: batch.id },
      data: {
        status: AnalysisJobBatchStatus.RUNNING,
        startedAt: new Date(),
        attemptCount: {
          increment: 1,
        },
      },
    });
  }

  public async markBatchSucceeded(data: {
    jobId: string;
    batchIndex: number;
    processedMemories: number;
    resultCacheKey: string;
    durationMs: number;
    finalStatus: AnalysisJobStatus;
  }): Promise<void> {
    const batch = await this.getBatch(data.jobId, data.batchIndex);

    if (batch === null) {
      throw new AppError('Analysis batch not found', {
        statusCode: 404,
        code: 'ANALYSIS_BATCH_NOT_FOUND',
      });
    }

    await this.prisma.$transaction([
      this.prisma.analysisJobBatch.update({
        where: { id: batch.id },
        data: {
          status: AnalysisJobBatchStatus.SUCCEEDED,
          completedAt: new Date(),
          durationMs: data.durationMs,
          resultCacheKey: data.resultCacheKey,
          errorCode: null,
          errorMessage: null,
        },
      }),
      this.prisma.analysisJob.update({
        where: { id: data.jobId },
        data: {
          status: data.finalStatus,
          startedAt: new Date(),
          completedBatches: {
            increment: 1,
          },
          processedMemories: {
            increment: data.processedMemories,
          },
          resultVersion: {
            increment: 1,
          },
          completedAt: data.finalStatus === AnalysisJobStatus.COMPLETED ? new Date() : null,
        },
      }),
    ]);
  }

  public async markBatchFailure(data: {
    jobId: string;
    batchIndex: number;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    receiveCount: number;
  }): Promise<void> {
    const batch = await this.getBatch(data.jobId, data.batchIndex);

    if (batch === null) {
      throw new AppError('Analysis batch not found', {
        statusCode: 404,
        code: 'ANALYSIS_BATCH_NOT_FOUND',
      });
    }

    const batchStatus = data.retryable ? AnalysisJobBatchStatus.RETRYING : AnalysisJobBatchStatus.FAILED;
    const jobStatus = data.retryable ? AnalysisJobStatus.PARTIAL : AnalysisJobStatus.PARTIAL_FAILED;

    await this.prisma.$transaction([
      this.prisma.analysisJobBatch.update({
        where: { id: batch.id },
        data: {
          status: batchStatus,
          errorCode: data.errorCode,
          errorMessage: data.errorMessage,
        },
      }),
      this.prisma.analysisJob.update({
        where: { id: data.jobId },
        data: {
          status: jobStatus,
          failedBatches: data.retryable ? undefined : { increment: 1 },
          lastErrorCode: data.errorCode,
          lastErrorMessage: data.errorMessage,
        },
      }),
    ]);
  }

  public async recordAudit(data: Prisma.RequestAuditMetaUncheckedCreateInput): Promise<void> {
    await this.prisma.requestAuditMeta.create({
      data,
    });
  }

  public async getTaxonomyVersion(version: string): Promise<{ version: string; updatedAt: Date; rules: TaxonomyRule[] }> {
    const rules = await this.getTaxonomyRules(version);
    return {
      version,
      updatedAt: rules[0]?.updatedAt ?? new Date(),
      rules,
    };
  }
}
