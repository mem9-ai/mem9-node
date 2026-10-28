import { Injectable } from '@nestjs/common';
import type {
  AnalysisJob,
  AnalysisJobBatch,
  ApiKeySubject,
  DeepAnalysisReport,
  MemoryReport,
  RateLimitPolicy,
  TaxonomyRule,
} from '@prisma/client';
import {
  AnalysisJobBatchStatus,
  AnalysisJobStatus,
  ApiKeySubjectStatus,
  DeepAnalysisReportStage,
  DeepAnalysisReportStatus,
  Prisma,
} from '@prisma/client';

import { AppError } from './errors';
import {
  DEEP_ANALYSIS_INITIAL_WAIT_MS,
  DEEP_ANALYSIS_LEASE_MS,
  DEEP_ANALYSIS_QUEUE_WAIT_MS,
  DEEP_ANALYSIS_SOURCE_DEADLINE_MS,
  DEEP_ANALYSIS_WORKER_DEADLINE_MS,
} from './deep-analysis-lease';
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
  private memoryReportTableReady?: Promise<void>;

  public constructor(private readonly prisma: PrismaService) {}

  public async findApiKeySubject(fingerprint: Buffer): Promise<ApiKeySubject | null> {
    return this.prisma.apiKeySubject.findUnique({
      where: { apiKeyFingerprint: toPrismaBytes(fingerprint) },
    });
  }

  public async recordVerifiedApiKeySubject(
    fingerprint: Buffer,
    verifiedAt: Date,
  ): Promise<ApiKeySubject> {
    return this.prisma.apiKeySubject.upsert({
      where: { apiKeyFingerprint: toPrismaBytes(fingerprint) },
      create: {
        id: createPrefixedId('aks'),
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        status: ApiKeySubjectStatus.ACTIVE,
        planCode: 'default',
        lastSeenAt: verifiedAt,
        lastVerifyAt: verifiedAt,
      },
      update: {
        lastSeenAt: verifiedAt,
        lastVerifyAt: verifiedAt,
      },
    });
  }

  public async markApiKeySubjectSeen(id: string): Promise<void> {
    await this.prisma.apiKeySubject.update({
      where: { id },
      data: { lastSeenAt: new Date() },
    });
  }

  public async getActiveApiKeySubject(fingerprint: Buffer): Promise<ApiKeySubject> {
    const subject = await this.findApiKeySubject(fingerprint);

    if (subject === null) {
      throw new AppError('API key subject not found', {
        statusCode: 401,
        code: 'API_KEY_REQUIRED',
      });
    }

    if (subject.status !== ApiKeySubjectStatus.ACTIVE) {
      throw new AppError('API key subject is not active', {
        statusCode: 403,
        code: 'API_KEY_DISABLED',
      });
    }

    return subject;
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
    await this.prisma.analysisJob.updateMany({
      where: {
        id: jobId,
        status: {
          in: [
            AnalysisJobStatus.UPLOADING,
            AnalysisJobStatus.PROCESSING,
            AnalysisJobStatus.PARTIAL,
          ],
        },
      },
      data: {
        status: AnalysisJobStatus.PROCESSING,
        startedAt: new Date(),
      },
    });

    return this.getJob(jobId);
  }

  public async markJobFailed(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<AnalysisJob> {
    await this.prisma.analysisJob.updateMany({
      where: {
        id: jobId,
        status: {
          in: [
            AnalysisJobStatus.UPLOADING,
            AnalysisJobStatus.PROCESSING,
            AnalysisJobStatus.PARTIAL,
          ],
        },
      },
      data: {
        status: AnalysisJobStatus.FAILED,
        completedAt: new Date(),
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
      },
    });

    return this.getJob(jobId);
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
      this.prisma.analysisJob.updateMany({
        where: {
          id: data.jobId,
          status: { not: AnalysisJobStatus.CANCELLED },
        },
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
      this.prisma.analysisJob.updateMany({
        where: {
          id: data.jobId,
          status: { not: AnalysisJobStatus.CANCELLED },
        },
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

  public async findDeepAnalysisReportByDay(
    fingerprint: Buffer,
    requestDayKey: string,
  ): Promise<DeepAnalysisReport | null> {
    return this.prisma.deepAnalysisReport.findFirst({
      where: {
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        requestDayKey,
        deletedAt: null,
      },
    });
  }

  public async findDeepAnalysisQuotaReports(
    fingerprint: Buffer,
    now = new Date(),
  ): Promise<DeepAnalysisReport[]> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return this.prisma.deepAnalysisReport.findMany({
      where: {
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        // Count retained usage regardless of its original timezone or deletion.
        // A running report also blocks admission after its quota day has ended.
        OR: [
          { requestedAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86400000) } },
          { deletedAt: null, status: { in: ['QUEUED', 'PREPARING', 'ANALYZING', 'SYNTHESIZING'] } },
        ],
      },
      orderBy: {
        requestedAt: 'desc',
      },
    });
  }

  public async createDeepAnalysisReport(data: {
    fingerprint: Buffer;
    enforceQuota: boolean;
    bypassDailyLimit: boolean;
    lang: string;
    timezone: string;
    memoryCount: number;
    sourceSnapshotObjectKey: string;
  }): Promise<DeepAnalysisReport> {
    return this.prisma.$transaction(async (tx) => {
      const fingerprint = toPrismaBytes(data.fingerprint);
      // Lock a stable owner row, including when this owner has no reports yet.
      // Every API replica must hold this lock through quota checks and insertion.
      const owners = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM ApiKeySubject
        WHERE apiKeyFingerprint = ${fingerprint} AND status = 'ACTIVE'
        FOR UPDATE
      `);
      if (owners.length !== 1) {
        throw new AppError('API key subject is not active', {
          statusCode: 403,
          code: 'API_KEY_DISABLED',
        });
      }

      // Use one admission timestamp after acquiring the lock, even across midnight.
      const now = new Date();
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      if (data.enforceQuota) {
        const running = await tx.deepAnalysisReport.findFirst({
          where: {
            apiKeyFingerprint: fingerprint,
            deletedAt: null,
            status: { in: ['QUEUED', 'PREPARING', 'ANALYZING', 'SYNTHESIZING'] },
          },
        });
        if (running) {
          throw new AppError('A deep analysis report is already running', {
            statusCode: 409,
            code: 'DEEP_ANALYSIS_ALREADY_RUNNING',
            details: { reportId: running.id },
          });
        }

        const count = await tx.deepAnalysisReport.count({
          where: {
            apiKeyFingerprint: fingerprint,
            requestedAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86400000) },
          },
        });
        if (!data.bypassDailyLimit && count >= 3) {
          throw new AppError('Deep analysis can be executed at most 3 times per day', {
            statusCode: 409,
            code: 'DEEP_ANALYSIS_DAILY_LIMIT',
            details: { maximumPerDay: 3 },
          });
        }
      }

      const id = createPrefixedId('dar');
      return tx.deepAnalysisReport.create({
        data: {
          id,
          apiKeyFingerprint: fingerprint,
          // An opaque run ID avoids collisions with legacy timezone keys and deleted slots.
          requestDayKey: `${now.toISOString().slice(0, 10)}@UTC#${id}`,
          requestedAt: now,
          leaseExpiresAt: new Date(now.getTime() + DEEP_ANALYSIS_INITIAL_WAIT_MS),
          lang: data.lang,
          timezone: data.timezone,
          memoryCount: data.memoryCount,
          sourceSnapshotObjectKey: data.sourceSnapshotObjectKey,
          status: DeepAnalysisReportStatus.QUEUED,
          stage: DeepAnalysisReportStage.FETCH_SOURCE,
        },
      });
    });
  }

  public async claimDeepAnalysisExecution(
    reportId: string,
    fingerprint: Buffer,
    phase: 'source' | 'worker',
  ): Promise<string | null> {
    const now = new Date();
    const token = createPrefixedId('lease');
    const result = await this.prisma.deepAnalysisReport.updateMany({
      where: {
        id: reportId,
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        deletedAt: null,
        status: DeepAnalysisReportStatus.QUEUED,
        stage: phase === 'source' ? DeepAnalysisReportStage.FETCH_SOURCE : DeepAnalysisReportStage.PREPROCESS,
        executionToken: null,
        leaseExpiresAt: { gt: now },
      },
      data: {
        executionToken: token,
        leaseExpiresAt: new Date(now.getTime() + DEEP_ANALYSIS_LEASE_MS),
        executionDeadlineAt: new Date(now.getTime() + (phase === 'source'
          ? DEEP_ANALYSIS_SOURCE_DEADLINE_MS : DEEP_ANALYSIS_WORKER_DEADLINE_MS)),
        status: DeepAnalysisReportStatus.PREPARING,
        startedAt: now,
      },
    });
    return result.count === 1 ? token : null;
  }

  private deepAnalysisExecutionWhere(
    reportId: string,
    fingerprint: Buffer,
    token: string,
    now: Date,
  ): Prisma.DeepAnalysisReportWhereInput {
    return {
      id: reportId,
      apiKeyFingerprint: toPrismaBytes(fingerprint),
      executionToken: token,
      deletedAt: null,
      status: { in: ['PREPARING', 'ANALYZING', 'SYNTHESIZING'] },
      leaseExpiresAt: { gt: now },
      executionDeadlineAt: { gt: now },
    };
  }

  public async renewDeepAnalysisExecution(
    reportId: string,
    fingerprint: Buffer,
    token: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.deepAnalysisReport.updateMany({
      where: this.deepAnalysisExecutionWhere(reportId, fingerprint, token, now),
      data: { leaseExpiresAt: new Date(now.getTime() + DEEP_ANALYSIS_LEASE_MS) },
    });
    return result.count === 1;
  }

  public async updateDeepAnalysisExecution(
    reportId: string,
    fingerprint: Buffer,
    token: string,
    data: Prisma.DeepAnalysisReportUncheckedUpdateInput,
  ): Promise<void> {
    const status = typeof data.status === 'string' ? data.status : data.status?.set;
    const terminal = status === 'COMPLETED' || status === 'FAILED';
    const result = await this.prisma.deepAnalysisReport.updateMany({
      where: this.deepAnalysisExecutionWhere(reportId, fingerprint, token, new Date()),
      data: {
        ...data,
        ...(terminal ? { executionToken: null, leaseExpiresAt: null, executionDeadlineAt: null } : {}),
      },
    });
    if (result.count !== 1) {
      throw new AppError('Deep analysis execution lease is no longer valid', {
        statusCode: 409, code: 'DEEP_ANALYSIS_LEASE_LOST',
      });
    }
  }

  public async handoffDeepAnalysisExecution(
    reportId: string,
    fingerprint: Buffer,
    token: string,
    memoryCount: number,
  ): Promise<void> {
    const now = new Date();
    const result = await this.prisma.deepAnalysisReport.updateMany({
      where: {
        ...this.deepAnalysisExecutionWhere(reportId, fingerprint, token, now),
        stage: DeepAnalysisReportStage.FETCH_SOURCE,
      },
      data: {
        status: DeepAnalysisReportStatus.QUEUED,
        stage: DeepAnalysisReportStage.PREPROCESS,
        progressPercent: 10,
        memoryCount,
        executionToken: null,
        executionDeadlineAt: null,
        leaseExpiresAt: new Date(now.getTime() + DEEP_ANALYSIS_QUEUE_WAIT_MS),
      },
    });
    if (result.count !== 1) {
      throw new AppError('Deep analysis execution lease is no longer valid', {
        statusCode: 409, code: 'DEEP_ANALYSIS_LEASE_LOST',
      });
    }
  }

  public async failRejectedDeepAnalysisEnqueue(
    reportId: string,
    fingerprint: Buffer,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.deepAnalysisReport.updateMany({
      where: {
        id: reportId,
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        deletedAt: null,
        status: DeepAnalysisReportStatus.QUEUED,
        stage: DeepAnalysisReportStage.PREPROCESS,
        executionToken: null,
        executionDeadlineAt: null,
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: DeepAnalysisReportStatus.FAILED,
        completedAt: now,
        errorCode: 'DEEP_ANALYSIS_ENQUEUE_REJECTED',
        errorMessage: 'The report could not be queued. Please create a new report.',
        executionToken: null,
        leaseExpiresAt: null,
        executionDeadlineAt: null,
      },
    });
    return result.count === 1;
  }

  public async expireStaleDeepAnalysisReports(now = new Date()): Promise<number> {
    // Null leases belong to pre-migration work. Reconcile those only after all
    // old binaries have stopped; age alone cannot establish abandonment.
    const result = await this.prisma.deepAnalysisReport.updateMany({
      where: {
        deletedAt: null,
        status: { in: ['QUEUED', 'PREPARING', 'ANALYZING', 'SYNTHESIZING'] },
        OR: [
          { leaseExpiresAt: { lte: now } },
          { executionDeadlineAt: { lte: now } },
        ],
      },
      data: {
        status: DeepAnalysisReportStatus.FAILED,
        completedAt: now,
        errorCode: 'DEEP_ANALYSIS_INTERRUPTED',
        errorMessage: 'Report processing was interrupted or exceeded its execution deadline. Please create a new report.',
        executionToken: null,
        leaseExpiresAt: null,
        executionDeadlineAt: null,
      },
    });
    return result.count;
  }

  public async listOwnedDeepAnalysisReports(
    fingerprint: Buffer,
    limit: number,
    offset: number,
  ): Promise<{ reports: DeepAnalysisReport[]; total: number }> {
    const where = {
      apiKeyFingerprint: toPrismaBytes(fingerprint),
      deletedAt: null,
    };
    const [reports, total] = await this.prisma.$transaction([
      this.prisma.deepAnalysisReport.findMany({
        where,
        orderBy: {
          requestedAt: 'desc',
        },
        take: limit,
        skip: offset,
      }),
      this.prisma.deepAnalysisReport.count({ where }),
    ]);

    return { reports, total };
  }

  public async getOwnedDeepAnalysisReport(
    reportId: string,
    fingerprint: Buffer,
  ): Promise<DeepAnalysisReport> {
    const report = await this.prisma.deepAnalysisReport.findFirst({
      where: {
        id: reportId,
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        deletedAt: null,
      },
    });

    if (report === null) {
      throw new AppError('Deep analysis report not found', {
        statusCode: 404,
        code: 'DEEP_ANALYSIS_REPORT_NOT_FOUND',
      });
    }

    return report;
  }

  public async getDeepAnalysisReport(reportId: string): Promise<DeepAnalysisReport> {
    const report = await this.prisma.deepAnalysisReport.findUnique({
      where: { id: reportId, deletedAt: null },
    });

    if (report === null) {
      throw new AppError('Deep analysis report not found', {
        statusCode: 404,
        code: 'DEEP_ANALYSIS_REPORT_NOT_FOUND',
      });
    }

    return report;
  }

  public async updateDeepAnalysisReport(
    reportId: string,
    data: Prisma.DeepAnalysisReportUncheckedUpdateInput,
  ): Promise<DeepAnalysisReport> {
    return this.prisma.deepAnalysisReport.update({
      where: { id: reportId, deletedAt: null },
      data,
    });
  }

  public async deleteDeepAnalysisReport(reportId: string): Promise<void> {
    await this.prisma.deepAnalysisReport.update({
      where: { id: reportId, deletedAt: null },
      data: {
        deletedAt: new Date(),
        previewJson: Prisma.DbNull,
        internalComment: null,
        reportObjectKey: null,
        sourceSnapshotObjectKey: '',
        errorCode: null,
        errorMessage: null,
      },
    });
  }

  public async createMemoryAnalysisReport(data: {
    fingerprint: Buffer;
    templateId: string;
    reportContent?: string;
    startTime: Date;
    endTime: Date;
    renderStatus: string;
    reportStage?: string;
    startedAt?: Date | null;
    completedAt?: Date | null;
    failCode?: string | null;
    failReason?: string | null;
    memoryCount: number;
  }): Promise<MemoryReport> {
    await this.ensureMemoryReportTable();

    return this.prisma.memoryReport.create({
      data: {
        apiKeyFingerprint: toPrismaBytes(data.fingerprint),
        templateId: data.templateId,
        reportContent: data.reportContent ?? '',
        startTime: data.startTime,
        endTime: data.endTime,
        renderStatus: data.renderStatus,
        reportStage: data.reportStage ?? 'queued',
        startedAt: data.startedAt ?? null,
        completedAt: data.completedAt ?? null,
        failCode: data.failCode ?? null,
        failReason: data.failReason ?? null,
        memoryCount: data.memoryCount,
      },
    });
  }

  public async updateMemoryAnalysisReport(
    reportId: number,
    fingerprint: Buffer,
    data: Prisma.MemoryReportUncheckedUpdateInput,
  ): Promise<MemoryReport> {
    await this.ensureMemoryReportTable();

    return this.prisma.memoryReport.update({
      where: {
        reportId,
        apiKeyFingerprint: toPrismaBytes(fingerprint),
      },
      data,
    });
  }

  public async expireStaleMemoryAnalysisReports(data: {
    templateId: string;
    queuedBefore: Date;
    runningBefore: Date;
    completedAt: Date;
    failCode: string;
    failReason: string;
  }): Promise<number> {
    await this.ensureMemoryReportTable();

    const result = await this.prisma.memoryReport.updateMany({
      where: {
        templateId: data.templateId,
        OR: [
          {
            renderStatus: 'queued',
            generatedAt: {
              lt: data.queuedBefore,
            },
          },
          {
            renderStatus: 'running',
            OR: [
              {
                startedAt: {
                  lt: data.runningBefore,
                },
              },
              {
                startedAt: null,
                generatedAt: {
                  lt: data.runningBefore,
                },
              },
            ],
          },
        ],
      },
      data: {
        renderStatus: 'fail',
        reportStage: 'failed',
        completedAt: data.completedAt,
        failCode: data.failCode,
        failReason: data.failReason,
      },
    });

    return result.count;
  }

  public async listMemoryAnalysisReportsByTemplateId(
    fingerprint: Buffer,
    templateId: string,
  ): Promise<MemoryReport[]> {
    await this.ensureMemoryReportTable();

    return this.prisma.memoryReport.findMany({
      where: {
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        templateId,
      },
      orderBy: {
        generatedAt: 'desc',
      },
    });
  }

  public async findMemoryAnalysisReport(
    fingerprint: Buffer,
    reportId: number,
  ): Promise<MemoryReport | null> {
    await this.ensureMemoryReportTable();

    return this.prisma.memoryReport.findFirst({
      where: {
        apiKeyFingerprint: toPrismaBytes(fingerprint),
        reportId,
      },
    });
  }

  public async findActiveMemoryAnalysisReportByDay(data: {
    fingerprint: Buffer;
    templateId: string;
    dayStart: Date;
    dayEnd: Date;
  }): Promise<MemoryReport | null> {
    await this.ensureMemoryReportTable();

    return this.prisma.memoryReport.findFirst({
      where: {
        apiKeyFingerprint: toPrismaBytes(data.fingerprint),
        templateId: data.templateId,
        generatedAt: {
          gte: data.dayStart,
          lt: data.dayEnd,
        },
        renderStatus: {
          in: ['queued', 'running'],
        },
      },
      orderBy: {
        generatedAt: 'desc',
      },
    });
  }

  public async countMemoryAnalysisReportsByDay(data: {
    fingerprint: Buffer;
    templateId: string;
    dayStart: Date;
    dayEnd: Date;
  }): Promise<number> {
    await this.ensureMemoryReportTable();

    return this.prisma.memoryReport.count({
      where: {
        apiKeyFingerprint: toPrismaBytes(data.fingerprint),
        templateId: data.templateId,
        generatedAt: {
          gte: data.dayStart,
          lt: data.dayEnd,
        },
      },
    });
  }

  private async ensureMemoryReportTable(): Promise<void> {
    this.memoryReportTableReady ??= this.initializeMemoryReportTable();
    return this.memoryReportTableReady;
  }

  private async initializeMemoryReportTable(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS \`memory_report\` (
        \`report_id\` INTEGER NOT NULL AUTO_INCREMENT,
        \`api_key_fingerprint\` VARBINARY(32) NOT NULL,
        \`template_id\` VARCHAR(255) NOT NULL,
        \`report_content\` LONGTEXT NOT NULL,
        \`generated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`started_at\` DATETIME(3) NULL,
        \`completed_at\` DATETIME(3) NULL,
        \`start_time\` DATETIME(3) NULL,
        \`end_time\` DATETIME(3) NULL,
        \`render_status\` VARCHAR(16) NOT NULL,
        \`report_stage\` VARCHAR(32) NOT NULL DEFAULT 'queued',
        \`fail_code\` VARCHAR(64) NULL,
        \`fail_reason\` LONGTEXT NULL,
        \`memory_count\` INTEGER NOT NULL,
        PRIMARY KEY (\`report_id\`),
        INDEX \`memory_report_owner_template_generated_idx\` (\`api_key_fingerprint\`, \`template_id\`, \`generated_at\`),
        INDEX \`memory_report_owner_report_idx\` (\`api_key_fingerprint\`, \`report_id\`)
      );
    `);

    if (!(await this.hasMemoryReportColumn('api_key_fingerprint'))) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE \`memory_report\`
        ADD COLUMN \`api_key_fingerprint\` VARBINARY(32) NULL AFTER \`report_id\`;
      `);
    }

    if (!(await this.hasMemoryReportColumn('start_time'))) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE \`memory_report\`
        ADD COLUMN \`start_time\` DATETIME(3) NULL AFTER \`generated_at\`;
      `);
    }

    if (!(await this.hasMemoryReportColumn('started_at'))) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE \`memory_report\`
        ADD COLUMN \`started_at\` DATETIME(3) NULL AFTER \`generated_at\`;
      `);
    }

    if (!(await this.hasMemoryReportColumn('completed_at'))) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE \`memory_report\`
        ADD COLUMN \`completed_at\` DATETIME(3) NULL AFTER \`started_at\`;
      `);
    }

    if (!(await this.hasMemoryReportColumn('end_time'))) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE \`memory_report\`
        ADD COLUMN \`end_time\` DATETIME(3) NULL AFTER \`start_time\`;
      `);
    }

    if (!(await this.hasMemoryReportColumn('report_stage'))) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE \`memory_report\`
        ADD COLUMN \`report_stage\` VARCHAR(32) NOT NULL DEFAULT 'queued' AFTER \`render_status\`;
      `);
    }

    if (!(await this.hasMemoryReportColumn('fail_code'))) {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE \`memory_report\`
        ADD COLUMN \`fail_code\` VARCHAR(64) NULL AFTER \`report_stage\`;
      `);
    }

    if (!(await this.hasMemoryReportIndex('memory_report_owner_template_generated_idx'))) {
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX \`memory_report_owner_template_generated_idx\`
        ON \`memory_report\` (\`api_key_fingerprint\`, \`template_id\`, \`generated_at\`);
      `);
    }

    if (!(await this.hasMemoryReportIndex('memory_report_owner_report_idx'))) {
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX \`memory_report_owner_report_idx\`
        ON \`memory_report\` (\`api_key_fingerprint\`, \`report_id\`);
      `);
    }
  }

  private async hasMemoryReportColumn(columnName: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ count: bigint | number | string }[]>(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'memory_report'
        AND column_name = ${columnName};
    `);

    return Number(rows[0]?.count ?? 0) > 0;
  }

  private async hasMemoryReportIndex(indexName: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ count: bigint | number | string }[]>(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'memory_report'
        AND index_name = ${indexName};
    `);

    return Number(rows[0]?.count ?? 0) > 0;
  }
}
