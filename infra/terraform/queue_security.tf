# Provision the independent keyring value through the approved secret channel.
# Do not manage a secret version here: key material must not enter Terraform state.
resource "aws_secretsmanager_secret" "queue_credentials" {
  name                    = "${var.name_prefix}-queue-credentials"
  description             = "Independent encryption keyring for queued report credentials"
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "api_runtime" {
  name               = "${var.name_prefix}-api-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy" "api_runtime" {
  name   = "${var.name_prefix}-api-runtime"
  role   = aws_iam_role.api_runtime.id
  policy = data.aws_iam_policy_document.api_runtime.json
}

data "aws_iam_policy_document" "api_runtime" {
  statement {
    sid = "PayloadObjects"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject"
    ]

    resources = ["${aws_s3_bucket.analysis_payloads.arn}/*"]
  }

  statement {
    sid     = "ProduceAnalysisQueues"
    actions = ["sqs:SendMessage"]

    resources = [
      aws_sqs_queue.analysis_batch.arn,
      aws_sqs_queue.analysis_llm.arn
    ]
  }
}

output "queue_credentials_secret_arn" {
  description = "Secret ARN for provisioning the queue keyring outside Terraform state."
  value       = aws_secretsmanager_secret.queue_credentials.arn
}
