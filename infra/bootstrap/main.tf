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
  #checkov:skip=CKV_AWS_109:Key policies scope "*" to the key itself; root access is the AWS default key policy
  #checkov:skip=CKV_AWS_111:Key policies scope "*" to the key itself; root access is the AWS default key policy
  #checkov:skip=CKV_AWS_356:Key policies scope "*" to the key itself; root access is the AWS default key policy
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
  #checkov:skip=CKV_AWS_144:Single-region deployment; versioning covers state recovery
  #checkov:skip=CKV2_AWS_62:Nothing consumes state bucket events
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_logging" "tf_state" {
  bucket        = aws_s3_bucket.tf_state.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "tf-state/"
  depends_on    = [aws_s3_bucket_policy.access_logs]
}

resource "aws_s3_bucket_lifecycle_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = 365
      newer_noncurrent_versions = 50
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
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

#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "access_logs" {
  #checkov:skip=CKV_AWS_18:This is the access log target bucket
  #checkov:skip=CKV_AWS_144:Single-region deployment
  #checkov:skip=CKV_AWS_145:S3 server access logging only delivers to SSE-S3 buckets
  #checkov:skip=CKV2_AWS_62:Nothing consumes access log events
  bucket = "${var.state_bucket_name}-logs"
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

#tfsec:ignore:aws-s3-encryption-customer-key
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "access_logs" {
  statement {
    sid       = "S3ServerAccessLogsDelivery"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.access_logs.arn}/tf-state/*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.tf_state.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket     = aws_s3_bucket.access_logs.id
  policy     = data.aws_iam_policy_document.access_logs.json
  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}
