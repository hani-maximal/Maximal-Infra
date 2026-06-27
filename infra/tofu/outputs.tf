output "application_url" {
  description = "URL for the deployed Maximal dashboard."
  value = (
    var.domain_name != null
    ? "${var.certificate_arn != null ? "https" : "http"}://${var.domain_name}"
    : "${var.certificate_arn != null ? "https" : "http"}://${aws_lb.app.dns_name}"
  )
}

output "load_balancer_dns_name" {
  value = aws_lb.app.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.maximal.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "task_role_arn" {
  description = "Read-only application task role. It may assume only remediation_role_arns."
  value       = aws_iam_role.task.arn
}

output "ecs_remediation_role_arns" {
  description = "Scoped ECS roles provisioned for the future real AWS adapter."
  value       = { for key, role in aws_iam_role.ecs_remediation : key => role.arn }
}

output "lambda_remediation_role_arns" {
  description = "Scoped Lambda roles provisioned for the future real AWS adapter."
  value       = { for key, role in aws_iam_role.lambda_remediation : key => role.arn }
}

output "ops_db_endpoint" {
  description = "RDS endpoint for the ops (audit/incidents) database."
  value       = var.enable_database ? aws_db_instance.ops[0].endpoint : null
}

output "app_db_endpoint" {
  description = "RDS endpoint for the app (users/tenants/connectors) database."
  value       = var.enable_database ? aws_db_instance.app[0].endpoint : null
}

output "ops_db_secret_arn" {
  description = "Secrets Manager ARN for the RDS-managed ops DB credentials."
  value       = var.enable_database ? aws_db_instance.ops[0].master_user_secret[0].secret_arn : null
}

output "app_db_secret_arn" {
  description = "Secrets Manager ARN for the RDS-managed app DB credentials."
  value       = var.enable_database ? aws_db_instance.app[0].master_user_secret[0].secret_arn : null
}

output "app_config_secret_arn" {
  description = "Secrets Manager ARN containing JWT secret and integration tokens."
  value       = var.enable_database ? aws_secretsmanager_secret.app_config[0].arn : null
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint (host:port)."
  value       = var.enable_redis ? "${aws_elasticache_cluster.redis[0].cache_nodes[0].address}:6379" : null
}

output "contracts_bucket_name" {
  description = "S3 bucket name for contract storage."
  value       = var.enable_contracts_bucket ? aws_s3_bucket.contracts[0].id : null
}
