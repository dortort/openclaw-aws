output "alb_dns_name" {
  value       = module.service_stack.alb_dns_name
  description = "Internal ALB DNS name"
}

output "ecs_cluster_name" {
  value       = module.service_stack.ecs_cluster_name
  description = "ECS cluster name"
}

output "ecs_service_name" {
  value       = module.service_stack.ecs_service_name
  description = "ECS service name"
}

output "efs_file_system_id" {
  value       = module.service_stack.efs_file_system_id
  description = "EFS file system ID"
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.gateway.repository_url
  description = "ECR repository URL"
}
