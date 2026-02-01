output "instance_id" {
  value       = aws_instance.this.id
  description = "Tailscale router instance ID"
}

output "private_ip" {
  value       = aws_instance.this.private_ip
  description = "Tailscale router private IP"
}
