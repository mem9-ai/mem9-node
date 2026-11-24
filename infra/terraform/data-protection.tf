# These controls apply in place; they do not recreate the payload bucket.
resource "aws_s3_bucket_server_side_encryption_configuration" "analysis_payloads" {
  bucket = aws_s3_bucket.analysis_payloads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "analysis_payloads" {
  bucket                  = aws_s3_bucket.analysis_payloads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "analysis_payloads" {
  bucket = aws_s3_bucket.analysis_payloads.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.analysis_payloads.arn, "${aws_s3_bucket.analysis_payloads.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Existing unencrypted resources remain at their original addresses with
# prevent_destroy. Provision encrypted copies separately; cutover is a later,
# explicit operation after restore validation. See the migration runbook.
data "aws_db_snapshot" "encrypted_migration" {
  count                  = var.provision_encrypted_storage ? 1 : 0
  db_snapshot_identifier = var.encrypted_database_snapshot_identifier
}

resource "aws_db_instance" "mysql_encrypted" {
  count                     = var.provision_encrypted_storage ? 1 : 0
  identifier                = "${var.name_prefix}-mysql-encrypted"
  snapshot_identifier       = data.aws_db_snapshot.encrypted_migration[0].db_snapshot_arn
  engine                    = "mysql"
  instance_class            = aws_db_instance.mysql.instance_class
  storage_type              = "gp3"
  storage_encrypted         = true
  backup_retention_period   = 7
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-mysql-encrypted-final"
  publicly_accessible       = false
  parameter_group_name      = aws_db_parameter_group.mysql.name
  db_subnet_group_name      = aws_db_subnet_group.mysql.name
  vpc_security_group_ids    = [aws_security_group.db.id]

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.aws_db_snapshot.encrypted_migration[0].encrypted && startswith(data.aws_db_snapshot.encrypted_migration[0].engine_version, "8.4")
      error_message = "Restore requires an encrypted MySQL 8.4 snapshot copy, not an unencrypted original or an empty database."
    }
  }
}

resource "aws_elasticache_replication_group" "redis_encrypted" {
  count                      = var.provision_encrypted_storage ? 1 : 0
  replication_group_id       = replace("${var.name_prefix}-redis-enc", "-", "")
  description                = "Encrypted and authenticated Redis for ${var.name_prefix}"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  parameter_group_name       = "default.redis7"
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  automatic_failover_enabled = false
  snapshot_name              = var.redis_migration_snapshot_name
  snapshot_retention_limit   = 7
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = var.encrypted_redis_auth_token
  auth_token_update_strategy = "SET"

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  active_database_address = var.use_encrypted_storage ? aws_db_instance.mysql_encrypted[0].address : aws_db_instance.mysql.address
  active_redis_endpoint   = var.use_encrypted_storage ? aws_elasticache_replication_group.redis_encrypted[0].primary_endpoint_address : aws_elasticache_replication_group.redis.primary_endpoint_address
  redis_auth_secrets = var.use_encrypted_storage ? [{
    name      = "REDIS_PASSWORD"
    valueFrom = "${aws_secretsmanager_secret.app.arn}:REDIS_PASSWORD::"
  }] : []
}
