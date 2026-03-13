CREATE TABLE `ApiKeySubject` (
  `id` VARCHAR(64) NOT NULL,
  `apiKeyFingerprint` VARBINARY(32) NOT NULL,
  `status` ENUM('ACTIVE', 'DISABLED', 'PENDING') NOT NULL DEFAULT 'ACTIVE',
  `planCode` VARCHAR(64) NOT NULL,
  `lastSeenAt` DATETIME(3) NULL,
  `lastVerifyAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `ApiKeySubject_apiKeyFingerprint_key` (`apiKeyFingerprint`),
  INDEX `ApiKeySubject_planCode_idx` (`planCode`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RateLimitPolicy` (
  `id` VARCHAR(64) NOT NULL,
  `planCode` VARCHAR(64) NOT NULL,
  `rpmLimit` INTEGER NOT NULL,
  `dailyLimit` INTEGER NOT NULL,
  `burstLimit` INTEGER NOT NULL,
  `maxActiveJobs` INTEGER NOT NULL,
  `maxBatchesPerJob` INTEGER NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `RateLimitPolicy_planCode_key` (`planCode`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AnalysisJob` (
  `id` VARCHAR(64) NOT NULL,
  `apiKeyFingerprint` VARBINARY(32) NOT NULL,
  `status` ENUM('CREATED', 'UPLOADING', 'PROCESSING', 'PARTIAL', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'UPLOADING',
  `dateRangeStart` DATETIME(3) NOT NULL,
  `dateRangeEnd` DATETIME(3) NOT NULL,
  `expectedTotalMemories` INTEGER NOT NULL,
  `expectedTotalBatches` INTEGER NOT NULL,
  `uploadedBatches` INTEGER NOT NULL DEFAULT 0,
  `completedBatches` INTEGER NOT NULL DEFAULT 0,
  `failedBatches` INTEGER NOT NULL DEFAULT 0,
  `processedMemories` INTEGER NOT NULL DEFAULT 0,
  `batchSize` INTEGER NOT NULL,
  `pipelineVersion` VARCHAR(32) NOT NULL,
  `taxonomyVersion` VARCHAR(32) NOT NULL,
  `llmEnabled` BOOLEAN NOT NULL DEFAULT false,
  `resultVersion` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `expiresAt` DATETIME(3) NULL,
  `lastErrorCode` VARCHAR(64) NULL,
  `lastErrorMessage` VARCHAR(512) NULL,
  INDEX `AnalysisJob_apiKeyFingerprint_createdAt_idx` (`apiKeyFingerprint`, `createdAt`),
  INDEX `AnalysisJob_status_createdAt_idx` (`status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AnalysisJobBatch` (
  `id` VARCHAR(64) NOT NULL,
  `jobId` VARCHAR(64) NOT NULL,
  `batchIndex` INTEGER NOT NULL,
  `status` ENUM('EXPECTED', 'UPLOADED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYING', 'DLQ') NOT NULL DEFAULT 'EXPECTED',
  `memoryCount` INTEGER NOT NULL,
  `payloadHash` VARCHAR(64) NOT NULL,
  `payloadObjectKey` VARCHAR(255) NOT NULL,
  `attemptCount` INTEGER NOT NULL DEFAULT 0,
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `durationMs` INTEGER NULL,
  `resultCacheKey` VARCHAR(255) NULL,
  `errorCode` VARCHAR(64) NULL,
  `errorMessage` VARCHAR(512) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `AnalysisJobBatch_jobId_batchIndex_key` (`jobId`, `batchIndex`),
  INDEX `AnalysisJobBatch_jobId_status_idx` (`jobId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AnalysisJobBatch_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `AnalysisJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TaxonomyRule` (
  `id` VARCHAR(64) NOT NULL,
  `version` VARCHAR(32) NOT NULL,
  `category` VARCHAR(32) NOT NULL,
  `label` VARCHAR(128) NOT NULL,
  `lang` VARCHAR(32) NOT NULL,
  `matchType` ENUM('keyword', 'regex', 'phrase') NOT NULL,
  `pattern` VARCHAR(255) NOT NULL,
  `weight` INTEGER NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `TaxonomyRule_version_enabled_idx` (`version`, `enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AnalysisPipelineConfig` (
  `id` VARCHAR(64) NOT NULL,
  `version` VARCHAR(32) NOT NULL,
  `maxMemoriesPerRequest` INTEGER NOT NULL,
  `maxBodyBytes` INTEGER NOT NULL,
  `resultCacheEnabled` BOOLEAN NOT NULL DEFAULT true,
  `llmFallbackEnabled` BOOLEAN NOT NULL DEFAULT false,
  `defaultBatchSize` INTEGER NOT NULL,
  `partialResultTtlSeconds` INTEGER NOT NULL,
  `payloadRetentionDays` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `AnalysisPipelineConfig_version_key` (`version`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RequestAuditMeta` (
  `id` VARCHAR(64) NOT NULL,
  `requestId` VARCHAR(64) NOT NULL,
  `apiKeyFingerprint` VARBINARY(32) NOT NULL,
  `route` VARCHAR(255) NOT NULL,
  `jobId` VARCHAR(64) NULL,
  `batchIndex` INTEGER NULL,
  `memoryCount` INTEGER NULL,
  `statusCode` INTEGER NOT NULL,
  `latencyMs` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `RequestAuditMeta_requestId_idx` (`requestId`),
  INDEX `RequestAuditMeta_createdAt_idx` (`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
