resource "aws_secretsmanager_secret" "app" {
  name = "${var.name_prefix}-app-secrets"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    DATABASE_URL              = "mysql://${var.database_username}:${var.database_password}@${aws_db_instance.mysql.address}:3306/${var.database_name}"
    APP_PEPPER                = var.app_pepper
    GO_INTERNAL_SHARED_SECRET = var.go_internal_shared_secret
    QUEUE_CREDENTIAL_KEYRING  = var.queue_credential_keyring
    SENTRY_DSN                = var.sentry_dsn
    # Older task revisions still fetch this key at startup. An empty value keeps
    # rollback compatible without retaining the build-only Sentry credential.
    SENTRY_AUTH_TOKEN                             = ""
    QWEN_API_KEY                                  = var.qwen_api_key
    DEEP_ANALYSIS_DAILY_LIMIT_BYPASS_FINGERPRINTS = var.deep_analysis_daily_limit_bypass_fingerprints
  })
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}
