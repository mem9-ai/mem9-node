CREATE TABLE `MemoryAnalysisPeriodCache` (
  `id` VARCHAR(64) NOT NULL,
  `apiKeyFingerprint` VARBINARY(32) NOT NULL,
  `periodKey` VARCHAR(64) NOT NULL,
  `model` VARCHAR(128) NOT NULL,
  `promptVersion` VARCHAR(32) NOT NULL,
  `resultJson` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `MAPC_scope_key` (`apiKeyFingerprint`, `periodKey`, `model`, `promptVersion`),
  INDEX `MAPC_owner_period_idx` (`apiKeyFingerprint`, `periodKey`)
);
