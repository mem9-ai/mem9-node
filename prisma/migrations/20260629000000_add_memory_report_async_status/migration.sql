ALTER TABLE `memory_report`
  ADD COLUMN `started_at` DATETIME(3) NULL AFTER `generated_at`,
  ADD COLUMN `completed_at` DATETIME(3) NULL AFTER `started_at`,
  ADD COLUMN `report_stage` VARCHAR(32) NOT NULL DEFAULT 'queued' AFTER `render_status`,
  ADD COLUMN `fail_code` VARCHAR(64) NULL AFTER `report_stage`;
