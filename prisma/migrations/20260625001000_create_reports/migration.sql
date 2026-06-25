CREATE TABLE IF NOT EXISTS `reports` (
  `report_id` INTEGER NOT NULL AUTO_INCREMENT,
  `template_id` VARCHAR(255) NOT NULL,
  `report_content` LONGTEXT NOT NULL,
  `generated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `render_status` VARCHAR(16) NOT NULL,
  `fail_reason` LONGTEXT NOT NULL,
  PRIMARY KEY (`report_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
