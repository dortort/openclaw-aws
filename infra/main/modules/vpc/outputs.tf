output "vpc_id" {
  value       = aws_vpc.this.id
  description = "VPC ID"
}

output "private_subnet_ids" {
  value       = [for s in aws_subnet.private : s.id]
  description = "Private subnet IDs"
}

output "private_subnet_id_map" {
  value = zipmap(
    [for idx, _ in var.private_subnet_cidrs : tostring(idx)],
    [for s in aws_subnet.private : s.id]
  )
  description = "Private subnet IDs keyed by stable index"
}

output "public_subnet_ids" {
  value       = [for s in aws_subnet.public : s.id]
  description = "Public subnet IDs"
}
