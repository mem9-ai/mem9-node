#!/usr/bin/env sh
set -eu

awslocal s3 mb "s3://${S3_BUCKET_ANALYSIS_PAYLOADS:-mem9-analysis-payloads}" || true

awslocal sqs create-queue --queue-name analysis-batch-dlq >/dev/null
awslocal sqs create-queue --queue-name analysis-batch >/dev/null
awslocal sqs create-queue --queue-name analysis-llm-dlq >/dev/null
awslocal sqs create-queue --queue-name analysis-llm >/dev/null
