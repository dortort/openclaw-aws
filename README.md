# OpenClaw AWS
[![Deploy Main](https://github.com/dortort/openclaw-aws/actions/workflows/deploy-main.yml/badge.svg)](https://github.com/dortort/openclaw-aws/actions/workflows/deploy-main.yml)
[![PR Plan](https://github.com/dortort/openclaw-aws/actions/workflows/pr-plan.yml/badge.svg)](https://github.com/dortort/openclaw-aws/actions/workflows/pr-plan.yml)
[![Scheduled Rebuild and Deploy](https://github.com/dortort/openclaw-aws/actions/workflows/scheduled-rebuild.yml/badge.svg)](https://github.com/dortort/openclaw-aws/actions/workflows/scheduled-rebuild.yml)
[![Terraform >= 1.14.0](https://img.shields.io/badge/Terraform-%3E%3D%201.14.0-7B42BC?logo=terraform)](https://www.terraform.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![OpenClaw AWS Header](docs/assets/openclaw-infra-header.png)

Infrastructure and deployment pipeline for [OpenClaw](https://openclaw.ai), using a
single-writer ECS+EFS architecture with immutable images and durable state.

## Architecture (high level)

- ECR for container images (digest-pinned by default, tag selection supported)
- ECS on Fargate with `desired_count = 1` and serialized deployments
- EFS mounted via access point at `/state`
- Internal ALB reachable via optional Tailscale subnet router
- Secrets from Secrets Manager or SSM injected into task env
- Terraform remote state in S3 with native state locking

## Repo layout

```
app/                      # config-only app assets
infra/bootstrap/          # one-time backend bootstrap
infra/main/               # main stack composed from modules
.github/workflows/        # CI/CD
scripts/                  # helpers
```

## Deployment

[See the full step-by-step deployment guide here.](docs/DEPLOYMENT.md)
Need to run the OpenClaw CLI in the deployed task? See
[ECS Exec instructions.](docs/DEPLOYMENT.md#run-openclaw-cli-commands-ecs-exec)

## Bootstrap (run once)

1. `just tf-bootstrap init`
2. `just tf-bootstrap apply`

Or with Terraform directly:

1. `cd infra/bootstrap`
2. `terraform init`
3. `terraform apply`

Capture the outputs (state bucket, KMS key) and add them to
`infra/main/backend.tf` or set via `TF_VAR_*` and backend config.

## Main stack

1. `just tf-main init`
2. `just tf-main plan`
3. `just tf-main apply`

Or with Terraform directly:

1. `cd infra/main`
2. `terraform init`
3. `terraform plan`
4. `terraform apply`

## CI/CD

- PRs: Terraform lint/validate, security checks, and Docker lint/scan/tests
- Main: build/push image, tag release version, apply Terraform with digest, wait for ECS stable
- Schedule: nightly rebuild + deploy at 00:00 UTC

## Docker image

This repo builds the OpenClaw gateway image from upstream source. CI resolves the
latest OpenClaw release tag via the GitHub API, checks it out before the Docker
build, and passes the tag as `OPENCLAW_VERSION` to label the image. The pushed
image is tagged with both the repository commit SHA and the OpenClaw release tag.

Local build (manual):
1. Fetch the latest release tag:
   - `curl -fsSL https://api.github.com/repos/openclaw/openclaw/releases/latest | jq -r .tag_name`
2. Clone OpenClaw into `app/openclaw`:
   - `git clone --depth 1 --branch "<tag>" https://github.com/openclaw/openclaw app/openclaw`
3. Build the image:
   - `docker build --build-arg OPENCLAW_VERSION="<tag>" -t openclaw:local ./app`

Runtime knobs:
- `OPENCLAW_GATEWAY_BIND` (default: `lan`)
- `OPENCLAW_GATEWAY_PORT` (default: `18789`)
- `OPENCLAW_GATEWAY_TOKEN` (required for non-loopback binds; injected via Secrets Manager)
- Persistent state is under `/state` (config in `/state/.openclaw/openclaw.json`).

## Secrets/variables

This repo is public. Do not commit account IDs or sensitive values. Provide
values via GitHub Actions secrets and `TF_VAR_*` environment variables.
