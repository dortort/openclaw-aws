provider "aws" {
  region = var.region
}

variable "region" {
  type        = string
  description = "AWS region for the bootstrap resources"
}

variable "state_bucket_name" {
  type        = string
  description = "S3 bucket name for Terraform remote state"
}

variable "enable_kms" {
  type        = bool
  description = "Whether to create a KMS key for state encryption"
  default     = true
}

variable "github_actions_role_arn" {
  type        = string
  description = "IAM role ARN for GitHub Actions to use the state KMS key"
  default     = ""
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "tf_state_kms" {
  statement {
    sid    = "AllowRootAccess"
    effect = "Allow"
    actions = [
      "kms:*"
    ]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.github_actions_role_arn != "" ? [var.github_actions_role_arn] : []
    content {
      sid    = "AllowGitHubActionsUse"
      effect = "Allow"
      actions = [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey"
      ]
      principals {
        type        = "AWS"
        identifiers = [statement.value]
      }
      resources = ["*"]
    }
  }
}

resource "aws_kms_key" "tf_state" {
  count                   = var.enable_kms ? 1 : 0
  description             = "Terraform state KMS key"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.tf_state_kms.json
}

resource "aws_kms_alias" "tf_state" {
  count         = var.enable_kms ? 1 : 0
  name          = "alias/terraform-state"
  target_key_id = aws_kms_key.tf_state[0].key_id
}

resource "aws_s3_bucket" "tf_state" {
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.enable_kms ? "aws:kms" : "AES256"
      kms_master_key_id = var.enable_kms ? aws_kms_key.tf_state[0].arn : null
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
