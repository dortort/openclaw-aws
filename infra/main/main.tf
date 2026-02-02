provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix    = var.project_name
  repository_url = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/${var.ecr_repository_name}"
  image_uri      = var.gateway_image_tag != "" ? "${local.repository_url}:${var.gateway_image_tag}" : "${local.repository_url}@${var.gateway_image_digest}"
}

resource "aws_ecr_repository" "gateway" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "gateway" {
  repository = aws_ecr_repository.gateway.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Keep last 50 tagged images"
        selection = {
          tagStatus = "tagged"
          tagPrefixList = [
            "sha-",
            "v"
          ]
          countType   = "imageCountMoreThan"
          countNumber = 50
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

module "vpc" {
  source               = "./modules/vpc"
  project_name         = local.name_prefix
  vpc_cidr             = var.vpc_cidr
  private_subnet_cidrs = var.private_subnet_cidrs
  public_subnet_cidrs  = var.public_subnet_cidrs
  enable_nat           = var.enable_nat
}

resource "aws_security_group" "tailscale_router" {
  name        = "${local.name_prefix}-tailscale-sg"
  description = "Tailscale subnet router SG"
  vpc_id      = module.vpc.vpc_id

  dynamic "ingress" {
    for_each = var.tailscale_ssh_cidrs
    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

module "service_stack" {
  source                             = "./modules/service-stack"
  project_name                       = local.name_prefix
  vpc_id                             = module.vpc.vpc_id
  private_subnet_id_map              = module.vpc.private_subnet_id_map
  app_port                           = var.app_port
  health_check_path                  = var.health_check_path
  tailnet_cidrs                      = var.tailnet_cidrs
  tailscale_router_security_group_id = aws_security_group.tailscale_router.id
  cluster_name                       = "${local.name_prefix}-cluster"
  image_uri                          = local.image_uri
  container_port                     = var.app_port
  container_stop_timeout             = var.container_stop_timeout
  cpu                                = var.ecs_cpu
  memory                             = var.ecs_memory
  efs_posix_uid                      = var.efs_posix_uid
  efs_posix_gid                      = var.efs_posix_gid
  secret_env                         = var.secret_env
}

module "tailscale_router" {
  source                     = "./modules/tailscale-router"
  count                      = var.enable_tailscale_router ? 1 : 0
  project_name               = local.name_prefix
  vpc_id                     = module.vpc.vpc_id
  subnet_id                  = module.vpc.private_subnet_ids[0]
  security_group_id          = aws_security_group.tailscale_router.id
  ami_id                     = var.tailscale_router_ami_id
  instance_type              = var.tailscale_router_instance_type
  tailscale_auth_key_ssm_arn = var.tailscale_auth_key_ssm_parameter_arn
  advertise_routes           = var.vpc_cidr
}
