#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/state"
CONFIG_DIR="${HOME}/.openclaw"
CONFIG_PATH="${CONFIG_DIR}/openclaw.json"
CONFIG_SOURCE="/app/config/openclaw.json"

mkdir -p "${STATE_DIR}" "${CONFIG_DIR}" "${STATE_DIR}/workspace"

if [[ ! -w "${STATE_DIR}" ]]; then
  echo "State directory ${STATE_DIR} is not writable." >&2
  exit 1
fi

if [[ ! -f "${CONFIG_PATH}" && -f "${CONFIG_SOURCE}" ]]; then
  cp "${CONFIG_SOURCE}" "${CONFIG_PATH}"
fi

exec node dist/index.js gateway \
  --bind "${OPENCLAW_GATEWAY_BIND:-lan}" \
  --port "${OPENCLAW_GATEWAY_PORT:-18789}"
