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
