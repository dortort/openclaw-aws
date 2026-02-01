#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 0 ]]; then
  echo "Usage: ecs-shell.sh" >&2
  exit 1
fi

stack_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/main" && pwd)"

cluster="$(cd "${stack_dir}" && terraform output -raw ecs_cluster_name)"
service="$(cd "${stack_dir}" && terraform output -raw ecs_service_name)"

if [[ -z "${cluster}" || "${cluster}" == "null" ]]; then
  echo "Missing ecs_cluster_name output (run terraform apply first)" >&2
  exit 1
fi

if [[ -z "${service}" || "${service}" == "null" ]]; then
  echo "Missing ecs_service_name output (run terraform apply first)" >&2
  exit 1
fi

task_arn="$(aws ecs list-tasks \
  --cluster "${cluster}" \
  --service-name "${service}" \
  --query "taskArns[0]" \
  --output text)"

if [[ -z "${task_arn}" || "${task_arn}" == "None" ]]; then
  echo "No running task found for ${service}" >&2
  exit 1
fi

aws ecs execute-command \
  --cluster "${cluster}" \
  --task "${task_arn}" \
  --container "gateway" \
  --interactive \
  --command "/bin/sh"
