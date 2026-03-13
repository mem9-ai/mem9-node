terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.92"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_s3_bucket" "analysis_payloads" {
  bucket = var.analysis_payload_bucket_name
}

resource "aws_s3_bucket_lifecycle_configuration" "analysis_payloads" {
  bucket = aws_s3_bucket.analysis_payloads.id

  rule {
    id     = "expire-analysis-payloads"
    status = "Enabled"

    expiration {
      days = var.payload_retention_days
    }
  }
}

resource "aws_sqs_queue" "analysis_batch_dlq" {
  name = "${var.name_prefix}-analysis-batch-dlq"
}

resource "aws_sqs_queue" "analysis_batch" {
  name                       = "${var.name_prefix}-analysis-batch"
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.analysis_batch_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "analysis_llm_dlq" {
  name = "${var.name_prefix}-analysis-llm-dlq"
}

resource "aws_sqs_queue" "analysis_llm" {
  name                       = "${var.name_prefix}-analysis-llm"
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.analysis_llm_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name_prefix}-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name_prefix}-worker"
  retention_in_days = 14
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.name_prefix}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role" "task_runtime" {
  name               = "${var.name_prefix}-task-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy" "task_runtime" {
  name   = "${var.name_prefix}-task-runtime"
  role   = aws_iam_role.task_runtime.id
  policy = data.aws_iam_policy_document.task_runtime.json
}

resource "aws_security_group" "api" {
  name        = "${var.name_prefix}-api"
  description = "Placeholder SG for API tasks"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "worker" {
  name        = "${var.name_prefix}-worker"
  description = "Placeholder SG for worker tasks"
  vpc_id      = var.vpc_id
}

resource "aws_lb" "api" {
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.api.id]
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name_prefix}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path = "/health/ready"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_db_instance" "mysql" {
  identifier             = "${var.name_prefix}-mysql"
  engine                 = "mysql"
  engine_version         = "8.0.39"
  instance_class         = "db.t4g.micro"
  allocated_storage      = 20
  db_name                = var.database_name
  username               = var.database_username
  password               = var.database_password
  skip_final_snapshot    = true
  publicly_accessible    = false
  vpc_security_group_ids = [aws_security_group.api.id, aws_security_group.worker.id]
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.name_prefix}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.name_prefix}-redis"
  description                = "Redis for analysis progress and aggregates"
  node_type                  = "cache.t4g.micro"
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.api.id, aws_security_group.worker.id]
  automatic_failover_enabled = false
  num_cache_clusters         = 1
}

data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "task_runtime" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "sqs:DeleteMessage",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes"
    ]

    resources = [
      aws_s3_bucket.analysis_payloads.arn,
      "${aws_s3_bucket.analysis_payloads.arn}/*",
      aws_sqs_queue.analysis_batch.arn,
      aws_sqs_queue.analysis_batch_dlq.arn,
      aws_sqs_queue.analysis_llm.arn,
      aws_sqs_queue.analysis_llm_dlq.arn
    ]
  }
}
