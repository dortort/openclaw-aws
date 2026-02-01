#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${ALB_URL:-}" ]]; then
  curl -fsSL "${ALB_URL}"
  exit 0
fi

alb_dns="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/main" && terraform output -raw alb_dns_name)"

if [[ -z "${alb_dns}" || "${alb_dns}" == "null" ]]; then
  echo "Missing alb_dns_name output (run terraform apply first)" >&2
  exit 1
fi

ALB_URL="http://${alb_dns}:8080/health"
curl -fsSL "${ALB_URL}"
