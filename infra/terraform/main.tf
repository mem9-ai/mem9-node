terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.92"
    }
  }
}

moved {
  from = aws_vpc_security_group_ingress_rule.alb_http_in
  to   = aws_vpc_security_group_ingress_rule.alb_https_in
}

import {
  to = aws_vpc_security_group_ingress_rule.alb_http_redirect_in
  id = "sgr-0b9e2034b2b1fb1fd"
}

import {
  to = aws_lb_listener.https
  id = "arn:aws:elasticloadbalancing:ap-southeast-1:401696231252:listener/app/mem9-node-prod-alb/04df54f74e428044/cd982852312c563a"
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

    filter {}

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

resource "aws_iam_role_policy" "task_execution_secrets" {
  name = "${var.name_prefix}-task-execution-secrets"
  role = aws_iam_role.task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = aws_secretsmanager_secret.app.arn
      }
    ]
  })
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

resource "aws_iam_role_policy_attachment" "task_execution_ecs" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_lb" "api" {
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]
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

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "ALB security group"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "api" {
  name        = "${var.name_prefix}-api"
  description = "API service security group"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "worker" {
  name        = "${var.name_prefix}-worker"
  description = "Worker service security group"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db"
  description = "MySQL security group"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "redis" {
  name        = "${var.name_prefix}-redis"
  description = "Redis security group"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect_in" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_in" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_all_out" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}


resource "aws_vpc_security_group_egress_rule" "api_all_out" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "worker_all_out" {
  security_group_id = aws_security_group.worker.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_api" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 3306
  to_port                      = 3306
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_worker" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 3306
  to_port                      = 3306
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "db_all_out" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_api" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_worker" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "redis_all_out" {
  security_group_id = aws_security_group.redis.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.name_prefix}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_subnet_group" "mysql" {
  name       = "${var.name_prefix}-mysql"
  subnet_ids = var.database_subnet_ids

  tags = {
    Name = "${var.name_prefix}-mysql"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = "arn:aws:acm:ap-southeast-1:401696231252:certificate/b45d5c85-ae95-453e-b4b3-7802f09a2d2b"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09"

  default_action {
    type = "forward"

    forward {
      target_group {
        arn    = aws_lb_target_group.api.arn
        weight = 1
      }

      stickiness {
        enabled  = false
        duration = 3600
      }
    }
  }
}

resource "aws_db_instance" "mysql" {
  identifier        = "${var.name_prefix}-mysql"
  engine            = "mysql"
  instance_class    = "db.t4g.micro"
  allocated_storage = 20
  storage_type      = "gp3"

  db_name  = var.database_name
  username = var.database_username
  password = var.database_password

  backup_retention_period = 7
  skip_final_snapshot     = true
  publicly_accessible     = true

  db_subnet_group_name   = aws_db_subnet_group.mysql.name
  vpc_security_group_ids = [aws_security_group.db.id]
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

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = replace("${var.name_prefix}-redis", "-", "")
  description                = "Redis for ${var.name_prefix}"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  parameter_group_name       = "default.redis7"
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  automatic_failover_enabled = false
}
