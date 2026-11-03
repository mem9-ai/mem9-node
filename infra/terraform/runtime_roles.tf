locals {
  runtime_queue_actions = {
    api = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
    worker = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
  }
}

resource "aws_iam_role" "service_runtime" {
  for_each = local.runtime_queue_actions

  name               = "${var.name_prefix}-${each.key}-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

data "aws_iam_policy_document" "service_runtime" {
  for_each = local.runtime_queue_actions

  statement {
    sid       = "PayloadObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.analysis_payloads.arn}/*"]
  }

  statement {
    sid     = "MainQueuesOnly"
    actions = each.value
    resources = [
      aws_sqs_queue.analysis_batch.arn,
      aws_sqs_queue.analysis_llm.arn,
    ]
  }
}

resource "aws_iam_role_policy" "service_runtime" {
  for_each = local.runtime_queue_actions

  name   = "${var.name_prefix}-${each.key}-runtime"
  role   = aws_iam_role.service_runtime[each.key].id
  policy = data.aws_iam_policy_document.service_runtime[each.key].json
}
