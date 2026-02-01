variable "project_name" {
  type        = string
  description = "Project name used for naming"
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR"
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "Private subnet CIDRs"
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "Public subnet CIDRs"
  default     = []
}

variable "enable_nat" {
  type        = bool
  description = "Whether to provision a NAT gateway"
  default     = false
}
