data "aws_ssm_parameter" "tailscale_auth_key" {
  count           = var.tailscale_auth_key_ssm_arn != "" ? 1 : 0
  name            = var.tailscale_auth_key_ssm_arn
  with_decryption = true
}

locals {
  tailscale_auth_key = var.tailscale_auth_key_ssm_arn != "" ? data.aws_ssm_parameter.tailscale_auth_key[0].value : ""
}

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.project_name}-tailscale-router"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "this" {
  name = "${var.project_name}-tailscale-router"
  role = aws_iam_role.this.name
}

resource "aws_instance" "this" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.security_group_id]
  iam_instance_profile   = aws_iam_instance_profile.this.name
  ebs_optimized          = true
  monitoring             = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    encrypted = true
  }

  lifecycle {
    ignore_changes = [root_block_device, ebs_optimized]
  }

  user_data = <<-EOF
    #!/usr/bin/env bash
    set -euo pipefail
    curl -fsSL https://tailscale.com/install.sh | sh
    sysctl -w net.ipv4.ip_forward=1
    sysctl -w net.ipv6.conf.all.forwarding=1
    tailscale up --authkey="${local.tailscale_auth_key}" --ssh --advertise-routes=${var.advertise_routes}
  EOF

  tags = {
    Name = "${var.project_name}-tailscale-router"
  }
}
