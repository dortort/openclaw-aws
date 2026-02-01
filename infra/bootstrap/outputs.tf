output "state_bucket_name" {
  value       = aws_s3_bucket.tf_state.bucket
  description = "S3 bucket for Terraform remote state"
}

output "kms_key_arn" {
  value       = var.enable_kms ? aws_kms_key.tf_state[0].arn : null
  description = "KMS key ARN for state encryption"
}
