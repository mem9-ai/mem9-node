CREATE TABLE IF NOT EXISTS `memory_report` (
  `report_id` INTEGER NOT NULL AUTO_INCREMENT,
  `template_id` VARCHAR(255) NOT NULL,
  `report_content` LONGTEXT NOT NULL,
  `generated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `render_status` VARCHAR(16) NOT NULL,
  `fail_reason` LONGTEXT NULL,
  `memory_count` INTEGER NOT NULL,

  PRIMARY KEY (`report_id`),
  INDEX `memory_report_template_generated_idx` (`template_id`, `generated_at`)
);
