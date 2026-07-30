output "analysis_payload_bucket_name" {
  value = aws_s3_bucket.analysis_payloads.bucket
}

output "analysis_batch_queue_url" {
  value = aws_sqs_queue.analysis_batch.url
}

output "analysis_batch_dlq_url" {
  value = aws_sqs_queue.analysis_batch_dlq.url
}

output "analysis_llm_queue_url" {
  value = aws_sqs_queue.analysis_llm.url
}

output "api_load_balancer_dns_name" {
  value = aws_lb.api.dns_name
}

output "api_task_definition_arn" {
  value = aws_ecs_task_definition.api.arn
}

output "worker_task_definition_arn" {
  value = aws_ecs_task_definition.worker.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}
