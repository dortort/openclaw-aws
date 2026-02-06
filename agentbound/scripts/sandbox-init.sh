#!/bin/sh
# AgentBound Sandbox Init Script
#
# Runs as PID 1 inside the sandbox container. Applies network policy rules
# (if the AGENTBOUND_NETWORK_POLICY env var is set) and then execs the
# MCP server command.
#
# This script is part of the AgentBox policy enforcement engine.

set -e

# -------------------------------------------------------------------------
# Apply network policy (iptables rules)
# -------------------------------------------------------------------------
if [ -n "$AGENTBOUND_NETWORK_POLICY" ]; then
    if command -v iptables >/dev/null 2>&1; then
        echo "[agentbound] Applying network policy..." >&2
        eval "$AGENTBOUND_NETWORK_POLICY"
        echo "[agentbound] Network policy applied." >&2
    else
        echo "[agentbound] WARNING: iptables not available, network policy not enforced." >&2
    fi
fi

# -------------------------------------------------------------------------
# Log sandbox info
# -------------------------------------------------------------------------
echo "[agentbound] Sandbox started at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
echo "[agentbound] User: $(whoami) (UID=$(id -u))" >&2
echo "[agentbound] Executing: $*" >&2

# -------------------------------------------------------------------------
# Exec the MCP server
# -------------------------------------------------------------------------
exec "$@"
