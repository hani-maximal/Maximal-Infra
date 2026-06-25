# Maximal on AWS with OpenTofu

This stack hosts the Maximal web service on ECS/Fargate behind an Application Load Balancer.

It creates:

- A VPC with two or three public subnets
- An internet-facing Application Load Balancer
- An ECS cluster, Fargate task definition, and service
- An ECR repository with immutable tags and image scanning
- CloudWatch log storage
- A read-only operational evidence task role
- Optional, individually scoped ECS and Lambda remediation roles
- Optional ACM HTTPS listener and Route 53 alias

## Important current limitation

The application still uses `MockAwsAdapter`. The OpenTofu deployment therefore forces
`MAXIMAL_MODE=observe`. Provisioned remediation roles are inert until the real AWS SDK
and STS adapter is implemented and tested.

Incidents and audit records are also still held in memory. The stack therefore runs
exactly one task and uses a non-overlapping deployment strategy. Add PostgreSQL-backed
repositories before enabling multiple tasks, rolling overlap, or autoscaling.

## Why Fargate plus an ALB?

Fargate runs the Node.js application without managing EC2 hosts. The ALB provides a stable
HTTP/HTTPS endpoint, health checks, and routing to task IP addresses. Fargate tasks using
`awsvpc` networking require an ALB target group with `target_type = "ip"`.

The starter uses public subnets and public task IPs to avoid NAT Gateway cost. The task
security group accepts inbound traffic only from the ALB. A hardened production version
can move tasks into private subnets and add NAT Gateways or VPC endpoints.

## Prerequisites

- OpenTofu 1.8+
- Docker
- AWS CLI authenticated through IAM Identity Center, an assumed role, or another temporary-credential method
- Permission to create VPC, ECS, ECR, ELBv2, IAM, CloudWatch, and optional Route 53/ACM resources

Do not create an IAM user access key specifically for the application. The deployed ECS
task receives temporary credentials from its task role.

## Deployment

Copy the example variables:

```bash
cd infra/tofu
cp terraform.tfvars.example terraform.tfvars
```

Set `allowed_ingress_cidrs` to your office or VPN egress IP. The app does not yet have
application-level login, so do not expose it to `0.0.0.0/0`.

Initialize and create the ECR repository first:

```bash
tofu init
tofu apply -target=aws_ecr_repository.maximal
```

Build and push an immutable image from the repository root:

```bash
export AWS_REGION=us-east-1
export IMAGE_TAG="$(git rev-parse --short HEAD)"
export ECR_URL="$(tofu output -raw ecr_repository_url)"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%/*}"

docker build -t "$ECR_URL:$IMAGE_TAG" ../..
docker push "$ECR_URL:$IMAGE_TAG"
```

Set the same `image_tag` in `terraform.tfvars`, then deploy:

```bash
tofu plan
tofu apply
tofu output -raw application_url
```

## TLS and DNS

Create or provide an ACM certificate in the same region as the ALB, then set:

```hcl
certificate_arn = "arn:aws:acm:..."
route53_zone_id = "Z..."
domain_name     = "maximal.example.com"
```

HTTP then redirects to HTTPS.

## State

Local state is acceptable only for a disposable sandbox. For shared environments, create
an S3 state bucket and lock table separately, then initialize with:

```bash
tofu init -backend-config=backend.example.hcl
```

Do not commit real backend names, account identifiers, certificates, or customer resource
ARNs into public repositories.
