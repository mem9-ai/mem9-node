# All provider operations are mocked: these tests never create cloud resources.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_subnet" {
    defaults = { cidr_block = "10.0.1.0/24" }
  }
  mock_data "aws_db_snapshot" {
    defaults = {
      encrypted       = true
      engine_version  = "8.4.9"
      db_snapshot_arn = "arn:aws:rds:ap-southeast-1:123456789012:snapshot:encrypted-final"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/test/1234567890123456" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/test/1234567890123456" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::test-payloads" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { url = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/test" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:test-123456" }
  }
  mock_resource "aws_db_instance" {
    defaults = { address = "original.db.example" }
  }
  mock_resource "aws_elasticache_replication_group" {
    defaults = { primary_endpoint_address = "original.cache.example" }
  }
  override_resource {
    target = aws_db_instance.mysql_encrypted[0]
    values = { address = "encrypted.db.example" }
  }
  override_resource {
    target = aws_elasticache_replication_group.redis_encrypted[0]
    values = { primary_endpoint_address = "encrypted.cache.example" }
  }
  # Inspect the configured container JSON before the real provider's apply-time
  # normalization. Other resources/data still use the mock provider's schema.
  override_resource {
    target = aws_ecs_task_definition.api
  }
  override_resource {
    target = aws_ecs_task_definition.worker
  }
}

variables {
  aws_region                = "ap-southeast-1"
  name_prefix               = "mem9-test"
  environment_name          = "staging"
  staging_enabled           = true
  release_id                = "0123456789abcdef0123456789abcdef01234567"
  api_image                 = "test-api:0123456789abcdef0123456789abcdef01234567"
  worker_image              = "test-worker:0123456789abcdef0123456789abcdef01234567"
  api_certificate_arn       = "arn:aws:acm:ap-southeast-1:123456789012:certificate/test"
  api_domain_name           = "staging.example.com"
  vpc_id                    = "vpc-12345678"
  public_subnet_ids         = ["subnet-12345678", "subnet-87654321"]
  private_subnet_ids        = ["subnet-12345678"]
  database_subnet_ids       = ["subnet-12345678", "subnet-87654321"]
  database_password         = "test-db-password"
  app_pepper                = "test-pepper-1234567890123456"
  go_internal_shared_secret = "test-shared-secret"
  queue_credential_keyring  = "test-keyring"
  sentry_dsn                = ""
  mem9_source_api_base_url  = "https://upstream.example.com/v1alpha2/mem9s"
  qwen_model                = "test-model"
  qwen_api_key              = "test-api-key"
}

run "default_keeps_existing_storage_and_enforces_https" {
  command = plan
  assert {
    condition     = length(aws_db_instance.mysql_encrypted) == 0 && length(aws_elasticache_replication_group.redis_encrypted) == 0
    error_message = "An ordinary release must not create or replace storage."
  }
  assert {
    condition     = local.active_database_address == aws_db_instance.mysql.address && local.active_redis_endpoint == aws_elasticache_replication_group.redis.primary_endpoint_address && length(local.redis_auth_secrets) == 0
    error_message = "Default rollout must retain both original endpoints."
  }
  assert {
    condition     = length(aws_lb_listener.https) == 1 && aws_lb_listener.https[0].port == 443 && aws_lb_listener.https[0].protocol == "HTTPS" && output.api_health_url == "https://staging.example.com/health/ready"
    error_message = "Staging must expose HTTPS with a certificate-covered health hostname."
  }
  assert {
    condition     = jsondecode(aws_s3_bucket_policy.analysis_payloads.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false" && jsondecode(aws_s3_bucket_policy.analysis_payloads.policy).Statement[0].Effect == "Deny"
    error_message = "Payload transport must reject HTTP."
  }
}

run "restore_without_cutover" {
  command = plan
  variables {
    provision_encrypted_storage            = true
    encrypted_database_snapshot_identifier = "encrypted-final"
    redis_migration_snapshot_name          = "redis-final"
    encrypted_redis_auth_token             = "test-redis-auth-token-123"
  }
  assert {
    condition     = aws_db_instance.mysql_encrypted[0].storage_encrypted && aws_elasticache_replication_group.redis_encrypted[0].at_rest_encryption_enabled && aws_elasticache_replication_group.redis_encrypted[0].auth_token_update_strategy == "SET"
    error_message = "Restored storage must encrypt data and require Redis AUTH."
  }
  assert {
    condition     = local.active_database_address == "original.db.example" && local.active_redis_endpoint == "original.cache.example" && length(local.redis_auth_secrets) == 0
    error_message = "Provisioning must not send application traffic to restored copies."
  }
}

run "explicit_cutover" {
  command = plan
  variables {
    provision_encrypted_storage            = true
    use_encrypted_storage                  = true
    encrypted_database_snapshot_identifier = "encrypted-final"
    redis_migration_snapshot_name          = "redis-final"
    encrypted_redis_auth_token             = "test-redis-auth-token-123"
  }
  assert {
    condition     = local.active_database_address == "encrypted.db.example" && local.active_redis_endpoint == "encrypted.cache.example" && local.redis_auth_secrets[0].name == "REDIS_PASSWORD"
    error_message = "Cutover must switch both endpoints and inject Redis authentication together."
  }
  assert {
    condition     = alltrue([for task in [aws_ecs_task_definition.api, aws_ecs_task_definition.worker] : contains([for secret in jsondecode(task.container_definitions)[0].secrets : secret.name], "REDIS_PASSWORD") && !contains([for env in jsondecode(task.container_definitions)[0].environment : env.name], "REDIS_PASSWORD")])
    error_message = "Both services must receive Redis AUTH via Secrets Manager, never a plaintext task environment value."
  }
}

run "reject_cutover_without_copies" {
  command = plan
  variables { use_encrypted_storage = true }
  expect_failures = [var.use_encrypted_storage]
}

run "reject_missing_restore_inputs" {
  command = plan
  variables { provision_encrypted_storage = true }
  expect_failures = [var.provision_encrypted_storage]
}

run "reject_plaintext_upstream" {
  command = plan
  variables { mem9_source_api_base_url = "http://staging.example/v1alpha2/mem9s" }
  expect_failures = [aws_ecs_task_definition.api, aws_ecs_task_definition.worker]
}

run "reject_unencrypted_database_snapshot" {
  command = plan
  variables {
    provision_encrypted_storage            = true
    encrypted_database_snapshot_identifier = "unencrypted-final"
    redis_migration_snapshot_name          = "redis-final"
    encrypted_redis_auth_token             = "test-redis-auth-token-123"
  }
  override_data {
    target = data.aws_db_snapshot.encrypted_migration[0]
    values = { encrypted = false, engine_version = "8.4.9" }
  }
  expect_failures = [aws_db_instance.mysql_encrypted[0]]
}

run "suspended_staging_has_no_ingress_or_tasks" {
  command = plan
  variables {
    staging_enabled          = false
    api_certificate_arn      = null
    api_domain_name          = null
    api_desired_count        = 6
    worker_desired_count     = 2
    mem9_source_api_base_url = "http://legacy-upstream.example/v1alpha2/mem9s"
  }
  assert {
    condition     = length(aws_lb_listener.https) == 0 && length(aws_vpc_security_group_ingress_rule.alb_https_in) == 0 && aws_ecs_service.api.desired_count == 0 && aws_ecs_service.worker.desired_count == 0
    error_message = "Suspended staging must stay at zero tasks without public ingress, even if old deployment variables request tasks."
  }
}

run "staging_suspension_does_not_stop_production" {
  command = plan
  variables {
    environment_name     = "prod"
    staging_enabled      = false
    api_desired_count    = 6
    worker_desired_count = 2
  }
  assert {
    condition     = aws_ecs_service.api.desired_count == 6 && aws_ecs_service.worker.desired_count == 2 && length(aws_lb_listener.https) == 1
    error_message = "The staging suspension flag must not change production capacity or ingress."
  }
}
