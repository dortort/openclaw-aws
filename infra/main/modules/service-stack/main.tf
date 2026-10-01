locals {
  name_prefix = var.project_name
  secret_arns = values(var.secret_env)
  secret_env_list = [
    for name, arn in var.secret_env : {
      name      = name
      valueFrom = arn
    }
  ]
  cluster_name       = var.cluster_name != "" ? var.cluster_name : "${var.project_name}-cluster"
  private_subnet_ids = sort(values(var.private_subnet_id_map))

  # Valid Fargate memory ranges per CPU value: [min, max, step]
  fargate_memory_limits = {
    256   = { min = 512, max = 2048, step = 512 }
    512   = { min = 1024, max = 4096, step = 1024 }
    1024  = { min = 2048, max = 8192, step = 1024 }
    2048  = { min = 4096, max = 16384, step = 1024 }
    4096  = { min = 8192, max = 30720, step = 1024 }
    8192  = { min = 16384, max = 61440, step = 4096 }
    16384 = { min = 32768, max = 122880, step = 8192 }
  }

  mem_limits       = local.fargate_memory_limits[var.cpu]
  memory_in_range  = var.memory >= local.mem_limits.min && var.memory <= local.mem_limits.max
  memory_on_step   = (var.memory - local.mem_limits.min) % local.mem_limits.step == 0
  valid_cpu_memory = local.memory_in_range && local.memory_on_step
}

data "aws_region" "current" {}

data "aws_iam_policy_document" "assume_ecs_task" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name_prefix}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_task.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_task.json
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets_access" {
  count = length(local.secret_arns) > 0 ? 1 : 0

  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "ssm:GetParameter",
      "ssm:GetParameters"
    ]
    resources = local.secret_arns
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "secrets_access" {
  count  = length(local.secret_arns) > 0 ? 1 : 0
  name   = "${local.name_prefix}-secrets-access"
  policy = data.aws_iam_policy_document.secrets_access[0].json
}

resource "aws_iam_role_policy_attachment" "execution_secrets" {
  count      = length(local.secret_arns) > 0 ? 1 : 0
  role       = aws_iam_role.execution.name
  policy_arn = aws_iam_policy.secrets_access[0].arn
}

data "aws_iam_policy_document" "ecs_exec" {
  #checkov:skip=CKV_AWS_111:ECS Exec ssmmessages actions do not support resource-level permissions
  #checkov:skip=CKV_AWS_356:ECS Exec ssmmessages actions do not support resource-level permissions
  statement {
    actions = [
      "ssm:UpdateInstanceInformation",
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "ecs_exec" {
  name   = "${local.name_prefix}-ecs-exec"
  policy = data.aws_iam_policy_document.ecs_exec.json
}

resource "aws_iam_role_policy_attachment" "task_ecs_exec" {
  role       = aws_iam_role.task.name
  policy_arn = aws_iam_policy.ecs_exec.arn
}

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb-sg"
  description = "ALB ingress from Tailscale"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Gateway from the Tailscale router"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [var.tailscale_router_security_group_id]
  }

  dynamic "ingress" {
    for_each = var.tailnet_cidrs
    content {
      description = "Gateway from the tailnet"
      from_port   = var.app_port
      to_port     = var.app_port
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    description = "Gateway targets in the VPC"
    from_port   = var.container_port
    to_port     = var.container_port
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
}

resource "aws_security_group" "ecs" {
  #checkov:skip=CKV_AWS_382:Unrestricted egress is only rendered when enable_nat is set, for model and channel APIs
  name        = "${local.name_prefix}-ecs-sg"
  description = "ECS service ingress from ALB"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Gateway from the ALB"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "VPC endpoints, EFS and in-VPC services"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description     = "ECR image layers via the S3 gateway endpoint"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [var.s3_prefix_list_id]
  }

  dynamic "egress" {
    for_each = var.allow_internet_egress ? [1] : []
    content {
      description = "Internet via NAT for model and channel APIs"
      from_port   = 0
      to_port     = 0
      protocol    = "-1"
      #tfsec:ignore:aws-ec2-no-public-egress-sgr
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}

resource "aws_security_group" "efs" {
  name        = "${local.name_prefix}-efs-sg"
  description = "EFS ingress from ECS"
  vpc_id      = var.vpc_id

  ingress {
    description     = "NFS from ECS tasks"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress = []
}

resource "aws_lb" "this" {
  #checkov:skip=CKV2_AWS_20:Internal ALB reached over the WireGuard-encrypted tailnet; HTTPS needs an ACM certificate and domain
  name                       = "${local.name_prefix}-alb"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.private_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = true

  access_logs {
    bucket  = var.access_logs_bucket
    prefix  = "alb"
    enabled = true
  }
}

resource "aws_lb_target_group" "this" {
  #checkov:skip=CKV_AWS_378:The gateway container serves plain HTTP inside the VPC
  name                 = "${local.name_prefix}-tg"
  port                 = var.app_port
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 20

  health_check {
    path                = var.health_check_path
    matcher             = "200-399"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

#tfsec:ignore:aws-elb-http-not-used
resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:Internal ALB reached over the WireGuard-encrypted tailnet; HTTPS needs an ACM certificate and domain
  #checkov:skip=CKV_AWS_103:No TLS listener until an ACM certificate is provided
  load_balancer_arn = aws_lb.this.arn
  port              = var.app_port
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

resource "aws_efs_file_system" "this" {
  #checkov:skip=CKV_AWS_184:Switching to a customer managed key forces file system replacement and loses gateway state
  encrypted = true

  tags = {
    Name = "${local.name_prefix}-efs"
  }
}

resource "aws_efs_mount_target" "this" {
  for_each        = var.private_subnet_id_map
  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "this" {
  file_system_id = aws_efs_file_system.this.id

  posix_user {
    uid = var.efs_posix_uid
    gid = var.efs_posix_gid
  }

  root_directory {
    path = "/state"
    creation_info {
      owner_uid   = var.efs_posix_uid
      owner_gid   = var.efs_posix_gid
      permissions = "0755"
    }
  }
}

resource "aws_ecs_cluster" "this" {
  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 365
  kms_key_id        = var.kms_key_arn
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${local.name_prefix}-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  lifecycle {
    precondition {
      condition     = local.valid_cpu_memory
      error_message = "Invalid Fargate cpu/memory combination: cpu=${var.cpu}, memory=${var.memory}. For ${var.cpu} CPU units, memory must be between ${local.mem_limits.min} and ${local.mem_limits.max} MiB in ${local.mem_limits.step} MiB increments."
    }
  }

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = var.image_uri
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      environment = [
        {
          name  = "OPENCLAW_GATEWAY_PORT"
          value = tostring(var.container_port)
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = data.aws_region.current.id
          awslogs-stream-prefix = "gateway"
        }
      }
      secrets                = local.secret_env_list
      stopTimeout            = var.container_stop_timeout
      readonlyRootFilesystem = false
      mountPoints = [
        {
          sourceVolume  = "state"
          containerPath = "/state"
          readOnly      = false
        }
      ]
    }
  ])

  volume {
    name = "state"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.this.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.this.id
        iam             = "ENABLED"
      }
    }
  }
}

resource "aws_ecs_service" "this" {
  name                              = "${local.name_prefix}-service"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.this.arn
  desired_count                     = 1
  health_check_grace_period_seconds = var.health_check_grace_period_seconds
  launch_type                       = "FARGATE"
  enable_execute_command            = true

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "gateway"
    container_port   = var.container_port
  }

  depends_on = [aws_iam_role_policy_attachment.execution_secrets]
}
