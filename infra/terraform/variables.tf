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
