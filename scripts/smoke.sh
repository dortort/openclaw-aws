#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${ALB_URL:-}" ]]; then
  echo "Set ALB_URL to the internal ALB URL (e.g., http://alb-dns:8080/health)"
  exit 1
fi

curl -fsSL "${ALB_URL}"
