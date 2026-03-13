resource "aws_secretsmanager_secret" "app" {
  name = "${var.name_prefix}-app-secrets"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    DATABASE_URL              = "mysql://${var.database_username}:${var.database_password}@${aws_db_instance.mysql.address}:3306/${var.database_name}"
    APP_PEPPER                = "m9_7Nq2fK8xP4sL1vR9tY3aB6wM0dH5uJ"
    GO_INTERNAL_SHARED_SECRET = "int_4pZ8sQ2mL7xC1vN9kD3rT6yH5uB0eW"
  })
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}
