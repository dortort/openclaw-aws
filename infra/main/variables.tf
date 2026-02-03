variable "region" {
  type        = string
  description = "AWS region"
}

variable "project_name" {
  type        = string
  description = "Project name used for resource naming"
  default     = "openclaw"
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR block"
  default     = "10.0.0.0/16"
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "Private subnet CIDRs (2-3 AZs)"
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "Public subnet CIDRs for NAT (optional)"
  default     = []
}

variable "enable_nat" {
  type        = bool
  description = "Whether to create a NAT gateway"
  default     = false
}

variable "app_port" {
  type        = number
  description = "Container and target group port"
  default     = 18789
}

variable "health_check_path" {
  type        = string
  description = "ALB target group health check path"
  default     = "/"
}

variable "health_check_grace_period_seconds" {
  type        = number
  description = "Grace period for ECS health checks to allow startup"
  default     = 180
}

variable "gateway_image_digest" {
  type        = string
  description = "ECR image digest for the gateway image (set this or gateway_image_tag)"
  default     = ""
}

variable "gateway_image_tag" {
  type        = string
  description = "ECR image tag for the gateway image (set this or gateway_image_digest)"
  default     = ""
}

variable "ecr_repository_name" {
  type        = string
  description = "ECR repository name"
  default     = "openclaw-gateway"
}

variable "ecs_cpu" {
  type        = number
  description = "ECS task CPU units"
  default     = 512
}

variable "ecs_memory" {
  type        = number
  description = "ECS task memory in MiB"
  default     = 1024
}

variable "container_stop_timeout" {
  type        = number
  description = "Seconds to allow for graceful shutdown"
  default     = 90
}

variable "efs_posix_uid" {
  type        = number
  description = "POSIX UID for EFS access point"
  default     = 1000
}

variable "efs_posix_gid" {
  type        = number
  description = "POSIX GID for EFS access point"
  default     = 1000
}

variable "tailscale_ssh_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to SSH to the Tailscale subnet router"
  default     = []
}

variable "tailnet_cidrs" {
  type        = list(string)
  description = "Tailnet CIDRs allowed to reach the internal ALB"
  default     = []
}

variable "enable_tailscale_router" {
  type        = bool
  description = "Whether to create a Tailscale subnet router instance"
  default     = false
}

variable "tailscale_router_ami_id" {
  type        = string
  description = "AMI ID for Tailscale router instance"
  default     = ""
}

variable "tailscale_router_instance_type" {
  type        = string
  description = "Instance type for Tailscale router"
  default     = "t3.micro"
}

variable "tailscale_auth_key_ssm_parameter_arn" {
  type        = string
  description = "SSM parameter name or ARN containing Tailscale auth key"
  default     = ""
}

variable "secret_env" {
  type        = map(string)
  description = "Map of environment variable name to Secrets Manager or SSM parameter ARN"
  default     = {}
}

variable "gateway_token" {
  type        = string
  description = "OpenClaw gateway token (stored in Secrets Manager)"
  default     = ""
  sensitive   = true
}
