data "aws_ssm_parameter" "tailscale_auth_key" {
  count           = var.tailscale_auth_key_ssm_arn != "" ? 1 : 0
  name            = var.tailscale_auth_key_ssm_arn
  with_decryption = true
}

locals {
  tailscale_auth_key = var.tailscale_auth_key_ssm_arn != "" ? data.aws_ssm_parameter.tailscale_auth_key[0].value : ""
}

resource "aws_instance" "this" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.security_group_id]

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
