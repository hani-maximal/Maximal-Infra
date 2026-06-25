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
  description = "Number of Fargate tasks. The in-memory prototype must remain at one."
  type        = number
  default     = 1

  validation {
    condition     = var.desired_count == 1
    error_message = "The current in-memory build must run exactly one task. Add PostgreSQL persistence before scaling out."
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
  description = "Runtime autonomy mode. The current deployment is forced to observe until the real AWS adapter is implemented."
  type        = string
  default     = "observe"

  validation {
    condition     = var.maximal_mode == "observe"
    error_message = "The current build uses a mock AWS adapter and may only be deployed in observe mode."
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

check "dns_configuration" {
  assert {
    condition = (
      (var.route53_zone_id == null && var.domain_name == null) ||
      (var.route53_zone_id != null && var.domain_name != null)
    )
    error_message = "route53_zone_id and domain_name must be provided together."
  }
}
