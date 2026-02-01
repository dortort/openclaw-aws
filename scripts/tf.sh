#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="${1:-main}"
shift || true

case "${STACK}" in
  bootstrap|main)
    ;;
  *)
    echo "Usage: tf.sh [bootstrap|main] [terraform args...]"
    exit 1
    ;;
esac

cd "${ROOT_DIR}/infra/${STACK}"
terraform "$@"
