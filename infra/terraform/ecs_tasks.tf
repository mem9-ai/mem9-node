resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task_runtime.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${aws_ecr_repository.api.repository_url}:latest"
      essential = true

      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::"
        },
        {
          name      = "APP_PEPPER"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:APP_PEPPER::"
        },
        {
          name      = "GO_INTERNAL_SHARED_SECRET"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:GO_INTERNAL_SHARED_SECRET::"
        },
        {
          name      = "QWEN_API_KEY"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:QWEN_API_KEY::"
        },
        {
          name      = "DEEP_ANALYSIS_DAILY_LIMIT_BYPASS_FINGERPRINTS"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:DEEP_ANALYSIS_DAILY_LIMIT_BYPASS_FINGERPRINTS::"
        }
      ]

      environment = [
        { name = "MEM9_SOURCE_API_BASE_URL", value = var.mem9_source_api_base_url },
        { name = "MEM9_SOURCE_PAGE_SIZE", value = "200" },
        { name = "MEM9_SOURCE_REQUEST_TIMEOUT_MS", value = tostring(var.mem9_source_request_timeout_ms) },
        { name = "MEM9_SOURCE_FETCH_RETRIES", value = tostring(var.mem9_source_fetch_retries) },
        { name = "MEM9_SOURCE_FETCH_RETRY_BASE_MS", value = tostring(var.mem9_source_fetch_retry_base_ms) },
        { name = "MEM9_SOURCE_DELETE_CONCURRENCY", value = tostring(var.mem9_source_delete_concurrency) },
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        { name = "TAXONOMY_VERSION", value = "v3" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET_ANALYSIS_PAYLOADS", value = aws_s3_bucket.analysis_payloads.bucket },
        { name = "SQS_ANALYSIS_BATCH_QUEUE_URL", value = aws_sqs_queue.analysis_batch.url },
        { name = "SQS_ANALYSIS_LLM_QUEUE_URL", value = aws_sqs_queue.analysis_llm.url },
        { name = "JOB_RESULT_TTL_SECONDS", value = "86400" },
        { name = "PAYLOAD_RETENTION_DAYS", value = tostring(var.payload_retention_days) },
        { name = "DEFAULT_BATCH_SIZE", value = "100" },
        { name = "MAX_BATCH_MEMORIES", value = "100" },
        { name = "MAX_BATCH_BYTES", value = "1048576" },
        { name = "GO_VERIFY_MODE", value = "noop" },
        { name = "LOG_LEVEL", value = "info" },
        { name = "REDIS_URL", value = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task_runtime.arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${aws_ecr_repository.worker.repository_url}:latest"
      essential = true

      portMappings = [
        {
          containerPort = 3001
          hostPort      = 3001
          protocol      = "tcp"
        }
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::"
        },
        {
          name      = "APP_PEPPER"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:APP_PEPPER::"
        },
        {
          name      = "GO_INTERNAL_SHARED_SECRET"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:GO_INTERNAL_SHARED_SECRET::"
        },
        {
          name      = "QWEN_API_KEY"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:QWEN_API_KEY::"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "WORKER_HEALTH_PORT", value = "3001" },
        { name = "TAXONOMY_VERSION", value = "v3" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "QWEN_API_BASE_URL", value = var.qwen_api_base_url },
        { name = "QWEN_MODEL", value = var.qwen_model },
        { name = "S3_BUCKET_ANALYSIS_PAYLOADS", value = aws_s3_bucket.analysis_payloads.bucket },
        { name = "SQS_ANALYSIS_BATCH_QUEUE_URL", value = aws_sqs_queue.analysis_batch.url },
        { name = "SQS_ANALYSIS_LLM_QUEUE_URL", value = aws_sqs_queue.analysis_llm.url },
        { name = "JOB_RESULT_TTL_SECONDS", value = "86400" },
        { name = "LOG_LEVEL", value = "info" },
        { name = "GO_VERIFY_MODE", value = "noop" },
        { name = "REDIS_URL", value = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}
