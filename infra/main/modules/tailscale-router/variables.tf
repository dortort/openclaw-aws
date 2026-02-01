variable "project_name" {
  type        = string
  description = "Project name for naming"
}

variable "vpc_id" {
  type        = string
  description = "VPC ID"
}

variable "subnet_id" {
  type        = string
  description = "Subnet ID for the router"
}

variable "security_group_id" {
  type        = string
  description = "Security group for the router"
}

variable "ami_id" {
  type        = string
  description = "AMI ID for the router instance"
}

variable "instance_type" {
  type        = string
  description = "Instance type for the router"
}

variable "tailscale_auth_key_ssm_arn" {
  type        = string
  description = "SSM parameter name or ARN storing the Tailscale auth key"
  default     = ""
}

variable "advertise_routes" {
  type        = string
  description = "CIDR routes to advertise to Tailscale"
}
