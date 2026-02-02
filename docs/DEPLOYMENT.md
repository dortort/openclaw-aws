# OpenClaw Infra Deployment Guide

This guide walks from zero to a working deployment, covering both local
Terraform and GitHub Actions CI/CD. The stack deploys an internal ALB, ECS on
Fargate, EFS for state, and ECR for images.

## Prerequisites

- AWS account with permissions to create VPC, ECS, ECR, EFS, ALB, and S3
- An IAM role for GitHub Actions OIDC (for CI/CD deploys)
- Tools: Terraform, AWS CLI, Docker, and `jq`
- Optional: `just` (for `Justfile` shortcuts)
- GitHub repository access and ability to set Actions secrets

## Step-by-step

1. Clone the repo and choose an AWS region.

   ```
   git clone https://github.com/<your-org>/openclaw-infra
   cd openclaw-infra
   export AWS_REGION="us-east-1"
   ```

2. Bootstrap remote state (run once).

   This creates the S3 state bucket and KMS key (optional).

   ```
   cd infra/bootstrap
   terraform init
   terraform apply \
     -var="region=${AWS_REGION}" \
     -var="state_bucket_name=<unique-state-bucket>" \
     -var="enable_kms=true"
   ```

   Or with `just`:
   ```
   just tf-bootstrap init
   just tf-bootstrap apply \
     -var="region=${AWS_REGION}" \
     -var="state_bucket_name=<unique-state-bucket>" \
     -var="enable_kms=true"
   ```

   Capture outputs:
   - `state_bucket_name`
   - `kms_key_arn`

3. Configure GitHub Actions secrets (for CI/CD).

   Required by `.github/workflows/deploy-main.yml`:
   - `AWS_REGION`
   - `AWS_ACCOUNT_ID`
   - `AWS_ROLE_ARN` (OIDC role for GitHub Actions)
   - `ECR_REPOSITORY` (default: `openclaw-gateway`)
   - `TF_STATE_BUCKET` (from bootstrap output)
   - `TF_STATE_KMS_KEY_ARN` (required when `enable_kms=true`)

   Optional for PR checks:
   - `INFRACOST_API_KEY`

4. Configure the main stack variables.

   Copy the example file and update values:

   ```
   cd ../main
   cp terraform.tfvars.example terraform.tfvars
   ```

   Required in `terraform.tfvars`:
   - `region`
   - `private_subnet_cidrs`
   - `gateway_image_digest` or `gateway_image_tag` (set after the first image build)

   Optional:
   - `enable_tailscale_router`, `tailscale_*` if you want tailnet access
   - `secret_env` map of env var names to Secrets Manager or SSM ARNs

5. Build and push the first image.

   Option A: CI/CD (recommended)
   - Set the secrets in step 3 and run the `Deploy Main` workflow, or push to
     `main` to trigger it.
   - The workflow builds, pushes, and exports the image digest used by Terraform.

   Option B: Manual build and push
   - Resolve the latest OpenClaw tag and build:
     ```
     tag="$(curl -fsSL https://api.github.com/repos/openclaw/openclaw/releases/latest | jq -r .tag_name)"
     git clone --depth 1 --branch "$tag" https://github.com/openclaw/openclaw app/openclaw
     aws ecr get-login-password --region "${AWS_REGION}" | \
       docker login --username AWS --password-stdin \
       "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
     IMAGE_TAG_SHA="sha-$(git rev-parse HEAD)"
     IMAGE_TAG_RELEASE="${tag}"
     IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
     docker build \
       --build-arg "OPENCLAW_VERSION=${tag}" \
       -t "${IMAGE_URI}:${IMAGE_TAG_SHA}" \
       -t "${IMAGE_URI}:${IMAGE_TAG_RELEASE}" \
       ./app
     docker push "${IMAGE_URI}:${IMAGE_TAG_SHA}"
     docker push "${IMAGE_URI}:${IMAGE_TAG_RELEASE}"
     ```
   - Fetch the digest:
     ```
     aws ecr describe-images \
       --repository-name "${ECR_REPOSITORY}" \
       --image-ids imageTag="${IMAGE_TAG_SHA}" \
       --query 'imageDetails[0].imageDigest' \
       --output text
     ```
   - Set `gateway_image_digest` in `terraform.tfvars` to that `sha256:...` value, or
     set `gateway_image_tag` to `${tag}` if you want to deploy by release tag.

6. Initialize the Terraform backend and apply the main stack.

   ```
   terraform init \
     -backend-config="bucket=${TF_STATE_BUCKET}" \
     -backend-config="region=${AWS_REGION}"
   # If enable_kms=true in bootstrap
   # -backend-config="kms_key_id=${TF_STATE_KMS_KEY_ARN}"
   terraform apply
   ```

   Or with `just`:
   ```
   just tf-main init \
     -backend-config="bucket=${TF_STATE_BUCKET}" \
     -backend-config="region=${AWS_REGION}"
   # If enable_kms=true in bootstrap
   # -backend-config="kms_key_id=${TF_STATE_KMS_KEY_ARN}"
   just tf-main apply
   ```

   The CI/CD workflow sets `TF_VAR_gateway_image_digest` automatically. Locally,
   make sure `gateway_image_digest` or `gateway_image_tag` is set in `terraform.tfvars`.

7. Verify deployment health.

   Get the internal ALB DNS name:
   ```
   terraform output -raw alb_dns_name
   ```

   From a network that can reach the ALB (for example via Tailscale), check the
   health endpoint:
   ```
   export ALB_URL="http://<alb-dns>:8080/health"
   ./scripts/smoke.sh
   ```
   Or with `just`:
   ```
   just smoke
   ```

8. Run OpenClaw CLI commands (ECS Exec).

   ECS Exec is enabled on the service. You can open a shell in the running task
   and run commands like `openclaw channels login` against the deployed state
   under `/state`.

   Prereqs:
   - AWS CLI v2 configured with credentials
   - IAM permissions for `ecs:ExecuteCommand` and `ssm:StartSession`

   Find the running task:
   ```
   aws ecs list-tasks \
     --cluster "<cluster-name>" \
     --service-name "<service-name>" \
     --query "taskArns[0]" \
     --output text
   ```

   Start a shell in the `gateway` container:
   ```
   aws ecs execute-command \
     --cluster "<cluster-name>" \
     --task "<task-arn>" \
     --container "gateway" \
     --interactive \
     --command "/bin/sh"
   ```
   Or with `just`:
   ```
   just ecs-shell
   ```

   Then run the CLI:
   ```
   openclaw channels login
   ```

9. Ongoing deploys.

   - Push to `main` to trigger `Deploy Main`.
   - Scheduled rebuild runs nightly at 00:00 UTC.
   - To deploy a specific image digest, set `TF_VAR_gateway_image_digest` and
     run `terraform apply`.
   - To deploy a specific release tag, set `TF_VAR_gateway_image_tag` and run
     `terraform apply`.

10. Troubleshooting and rollback.

   - ECS service not stable: check ECS service events and task logs.
   - ALB health failing: verify `app_port` and `health_check_path` in `terraform.tfvars`.
   - Rollback: re-apply with a previous `gateway_image_digest`.
