output "alb_dns_name" {
  value       = aws_lb.this.dns_name
  description = "Internal ALB DNS name"
}

output "ecs_cluster_name" {
  value       = aws_ecs_cluster.this.name
  description = "ECS cluster name"
}

output "ecs_service_name" {
  value       = aws_ecs_service.this.name
  description = "ECS service name"
}

output "efs_file_system_id" {
  value       = aws_efs_file_system.this.id
  description = "EFS file system ID"
}

output "efs_access_point_id" {
  value       = aws_efs_access_point.this.id
  description = "EFS access point ID"
}
