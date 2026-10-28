ALTER TABLE `DeepAnalysisReport`
  ADD COLUMN `executionToken` VARCHAR(64) NULL,
  ADD COLUMN `leaseExpiresAt` DATETIME(3) NULL,
  ADD COLUMN `executionDeadlineAt` DATETIME(3) NULL;
