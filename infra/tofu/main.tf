data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

locals {
  availability_zones = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)
  image_uri           = "${aws_ecr_repository.maximal.repository_url}:${var.image_tag}"
  dns_enabled         = var.route53_zone_id != null && var.domain_name != null
  created_remediation_role_arns = concat(
    [for role in aws_iam_role.ecs_remediation : role.arn],
    [for role in aws_iam_role.lambda_remediation : role.arn]
  )
  all_remediation_role_arns = concat(var.remediation_role_arns, local.created_remediation_role_arns)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  for_each = { for index, az in local.availability_zones : az => index }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name}-public-${each.key}"
    Tier = "public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Ingress to the Maximal Application Load Balancer"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "Forward traffic to Fargate tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = toset(var.allowed_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "Trusted HTTP client"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = var.certificate_arn == null ? toset([]) : toset(var.allowed_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "Trusted HTTPS client"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_security_group" "task" {
  name_prefix = "${var.name}-task-"
  description = "Network access for Maximal Fargate tasks"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "AWS APIs, package endpoints, and external integrations"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  description                  = "Application traffic from the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
}

resource "aws_ecr_repository" "maximal" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "maximal" {
  repository = aws_ecr_repository.maximal.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the most recent 30 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name = "${var.name}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "observation" {
  name = "${var.name}-observation"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadOperationalEvidence"
        Effect = "Allow"
        Action = [
          "cloudwatch:DescribeAlarms",
          "cloudwatch:GetMetricData",
          "cloudwatch:GetMetricStatistics",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:FilterLogEvents",
          "logs:GetLogEvents",
          "logs:GetQueryResults",
          "logs:StartQuery",
          "cloudtrail:LookupEvents",
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:DescribeTasks",
          "ecs:ListTaskDefinitions",
          "ecs:ListTasks",
          "lambda:GetAlias",
          "lambda:GetFunction",
          "lambda:ListAliases",
          "lambda:ListVersionsByFunction",
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetHealth",
          "sts:GetCallerIdentity"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "assume_remediation" {
  count = length(local.all_remediation_role_arns) > 0 ? 1 : 0

  name = "${var.name}-assume-remediation"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AssumeExplicitRemediationRoles"
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = local.all_remediation_role_arns
    }]
  })
}

resource "aws_iam_role" "ecs_remediation" {
  for_each = var.ecs_remediation_targets

  name = substr("${var.name}-ecs-${each.key}", 0, 64)

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { AWS = aws_iam_role.task.arn }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_remediation" {
  for_each = var.ecs_remediation_targets

  name = "update-one-service"
  role = aws_iam_role.ecs_remediation[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "UpdateOneEcsService"
      Effect   = "Allow"
      Action   = "ecs:UpdateService"
      Resource = each.value.service_arn
    }]
  })
}

resource "aws_iam_role" "lambda_remediation" {
  for_each = var.lambda_remediation_targets

  name = substr("${var.name}-lambda-${each.key}", 0, 64)

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { AWS = aws_iam_role.task.arn }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda_remediation" {
  for_each = var.lambda_remediation_targets

  name = "update-one-alias"
  role = aws_iam_role.lambda_remediation[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "UpdateAliasOnOneFunction"
      Effect   = "Allow"
      Action   = "lambda:UpdateAlias"
      Resource = each.value.function_arn
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = var.name
    image     = local.image_uri
    essential = true

    portMappings = [{
      name          = "http"
      containerPort = var.container_port
      hostPort      = var.container_port
      protocol      = "tcp"
      appProtocol   = "http"
    }]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "HOST", value = "0.0.0.0" },
      { name = "PORT", value = tostring(var.container_port) },
      { name = "MAXIMAL_MODE", value = var.maximal_mode },
      { name = "CONTRACTS_DIR", value = "contracts" }
    ]

    readonlyRootFilesystem = true

    healthCheck = {
      command = [
        "CMD-SHELL",
        "node -e \"fetch('http://127.0.0.1:${var.container_port}/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""
      ]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

resource "aws_lb" "app" {
  name               = substr("${var.name}-alb", 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for subnet in aws_subnet.public : subnet.id]

  enable_deletion_protection = false
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "app" {
  name        = substr("${var.name}-app", 0, 32)
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    enabled             = true
    path                = "/api/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30
}

resource "aws_lb_listener" "http_forward" {
  count = var.certificate_arn == null ? 1 : 0

  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count = var.certificate_arn == null ? 0 : 1

  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.certificate_arn == null ? 0 : 1

  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_service" "app" {
  name            = var.name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  wait_for_steady_state   = true

  # The current repository is in-memory. Avoid two concurrently serving tasks
  # until incidents and audit records are persisted in PostgreSQL.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [for subnet in aws_subnet.public : subnet.id]
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = var.name
    container_port   = var.container_port
  }

  depends_on = [
    aws_lb_listener.http_forward,
    aws_lb_listener.http_redirect,
    aws_lb_listener.https
  ]
}

resource "aws_route53_record" "app" {
  count = local.dns_enabled ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}
