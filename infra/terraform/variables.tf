variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "name_prefix" {
  type    = string
  default = "mem9-analysis"
}

variable "analysis_payload_bucket_name" {
  type    = string
  default = "mem9-analysis-payloads"
}

variable "payload_retention_days" {
  type    = number
  default = 7
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "database_subnet_ids" {
  type = list(string)
}

variable "database_name" {
  type    = string
  default = "mem9"
}

variable "database_username" {
  type    = string
  default = "mem9"
}

variable "database_password" {
  type      = string
  sensitive = true
}

variable "app_pepper" {
  type      = string
  sensitive = true
}

variable "go_internal_shared_secret" {
  type      = string
  sensitive = true
}

variable "mem9_source_api_base_url" {
  type = string
}

variable "mem9_source_request_timeout_ms" {
  type    = number
  default = 10000
}

variable "mem9_source_fetch_retries" {
  type    = number
  default = 2
}

variable "mem9_source_fetch_retry_base_ms" {
  type    = number
  default = 250
}

variable "mem9_source_delete_concurrency" {
  type    = number
  default = 4
}

variable "qwen_api_base_url" {
  type    = string
  default = "https://dashscope.aliyuncs.com/compatible-mode/v1"
}

variable "qwen_model" {
  type    = string
  default = "qwen3.5-plus"
}

variable "qwen_request_timeout_ms" {
  type    = number
  default = 120000
}

variable "qwen_api_key" {
  type      = string
  sensitive = true
}

variable "deep_analysis_daily_limit_bypass_fingerprints" {
  type      = string
  default   = ""
  sensitive = true
}
