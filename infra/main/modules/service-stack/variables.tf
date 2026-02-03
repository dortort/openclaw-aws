variable "project_name" {
  type        = string
  description = "Project name for naming"
}

variable "vpc_id" {
  type        = string
  description = "VPC ID"
}

variable "private_subnet_id_map" {
  type        = map(string)
  description = "Private subnet IDs keyed by stable index"
}

variable "app_port" {
  type        = number
  description = "Target group port"
}

variable "health_check_path" {
  type        = string
  description = "Target group health check path"
}

variable "health_check_grace_period_seconds" {
  type        = number
  description = "Grace period for ECS health checks to allow startup"
}

variable "tailnet_cidrs" {
  type        = list(string)
  description = "Tailnet CIDRs allowed to reach the ALB"
  default     = []
}

variable "tailscale_router_security_group_id" {
  type        = string
  description = "Security group ID for the Tailscale router"
}

variable "cluster_name" {
  type        = string
  description = "ECS cluster name override (optional)"
  default     = ""
}

variable "image_uri" {
  type        = string
  description = "Container image URI (tag or digest)"
}

variable "container_port" {
  type        = number
  description = "Container port"
}

variable "container_stop_timeout" {
  type        = number
  description = "Container stop timeout seconds"
  default     = 90
}

variable "cpu" {
  type        = number
  description = "Task CPU"
}

variable "memory" {
  type        = number
  description = "Task memory"
}

variable "efs_posix_uid" {
  type        = number
  description = "POSIX UID for EFS access point"
}

variable "efs_posix_gid" {
  type        = number
  description = "POSIX GID for EFS access point"
}

variable "secret_env" {
  type        = map(string)
  description = "Map of env var name to secret/parameter ARN"
  default     = {}
}
