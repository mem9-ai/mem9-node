CREATE TABLE IF NOT EXISTS `memory_report` (
  `report_id` INTEGER NOT NULL AUTO_INCREMENT,
  `api_key_fingerprint` VARBINARY(32) NOT NULL,
  `template_id` VARCHAR(255) NOT NULL,
  `report_content` LONGTEXT NOT NULL,
  `generated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `start_time` DATETIME(3) NULL,
  `end_time` DATETIME(3) NULL,
  `render_status` VARCHAR(16) NOT NULL,
  `fail_reason` LONGTEXT NULL,
  `memory_count` INTEGER NOT NULL,

  PRIMARY KEY (`report_id`),
  INDEX `memory_report_owner_template_generated_idx` (`api_key_fingerprint`, `template_id`, `generated_at`),
  INDEX `memory_report_owner_report_idx` (`api_key_fingerprint`, `report_id`)
);
