variable "name" {
  description = "Short name used for AWS resources."
  type        = string
  default     = "maximal"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.name)) && length(var.name) <= 20
    error_message = "name must contain lowercase letters, numbers, or hyphens and be at most 20 characters."
  }
}

variable "aws_region" {
  description = "AWS region for the deployment."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR block for the Maximal VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zone_count" {
  description = "Number of availability zones and public subnets."
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 3
    error_message = "Use two or three availability zones."
  }
}

variable "allowed_ingress_cidrs" {
  description = "CIDR ranges allowed to reach the ALB. Keep this restricted until authentication is enabled."
  type        = list(string)

  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0
    error_message = "At least one trusted ingress CIDR is required."
  }
}

variable "container_port" {
  description = "Port exposed by the Maximal container."
  type        = number
  default     = 4310
}

variable "image_tag" {
  description = "Image tag in the ECR repository created by this stack."
  type        = string
  default     = "latest"
}

variable "desired_count" {
  description = "Number of Fargate tasks. Requires enable_database = true to run more than one."
  type        = number
  default     = 1

  validation {
    condition     = var.desired_count >= 1 && var.desired_count <= 2
    error_message = "desired_count must be 1 or 2. Set enable_database = true before scaling beyond 1."
  }
}

variable "task_cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 1024
}

variable "maximal_mode" {
  description = "Runtime autonomy mode: observe (no writes) or remediate (live AWS writes via connector roles)."
  type        = string
  default     = "observe"

  validation {
    condition     = contains(["observe", "remediate"], var.maximal_mode)
    error_message = "maximal_mode must be 'observe' or 'remediate'."
  }
}

variable "certificate_arn" {
  description = "Optional ACM certificate ARN. When set, HTTP redirects to HTTPS."
  type        = string
  default     = null
  nullable    = true
}

variable "route53_zone_id" {
  description = "Optional Route 53 hosted zone ID."
  type        = string
  default     = null
  nullable    = true
}

variable "domain_name" {
  description = "Optional DNS name to create in Route 53, such as maximal.example.com."
  type        = string
  default     = null
  nullable    = true
}

variable "remediation_role_arns" {
  description = "Additional pre-existing remediation roles the task may assume. Empty means no external write role."
  type        = list(string)
  default     = []
}

variable "ecs_remediation_targets" {
  description = "Future ECS write roles keyed by a stable short name. The current application will not assume them until the real AWS adapter is implemented."
  type = map(object({
    service_arn = string
  }))
  default = {}
}

variable "lambda_remediation_targets" {
  description = "Future Lambda write roles keyed by a stable short name. The current application will not assume them until the real AWS adapter is implemented."
  type = map(object({
    function_arn = string
  }))
  default = {}
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Additional tags applied to resources."
  type        = map(string)
  default     = {}
}

# ── Data-tier feature flags ───────────────────────────────────────────────────

variable "enable_database" {
  description = "Provision RDS PostgreSQL instances (ops + app) and inject DB credentials via Secrets Manager."
  type        = bool
  default     = true
}

variable "enable_redis" {
  description = "Provision an ElastiCache Redis cluster for the job queue and learning pipeline."
  type        = bool
  default     = true
}

variable "enable_contracts_bucket" {
  description = "Provision an S3 bucket for contract storage and proposal hot-reload."
  type        = bool
  default     = true
}

variable "database_instance_class" {
  description = "RDS instance class for the ops and app PostgreSQL databases."
  type        = string
  default     = "db.t3.micro"
}

variable "redis_node_type" {
  description = "ElastiCache node type for the Redis cluster."
  type        = string
  default     = "cache.t3.micro"
}

check "dns_configuration" {
  assert {
    condition = (
      (var.route53_zone_id == null && var.domain_name == null) ||
      (var.route53_zone_id != null && var.domain_name != null)
    )
    error_message = "route53_zone_id and domain_name must be provided together."
  }
}
