/**
 * Network Policy Enforcement
 *
 * Translates NetworkScope entries from the RuntimePolicy into concrete
 * iptables rules that are applied inside the sandbox container.
 *
 * The paper describes using iptables for network allowlists — this module
 * generates the rule sets and provides utilities to verify connectivity.
 */

import type { NetworkScope, RuntimeScope } from "../types.js";
import { Permission } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IptablesRule {
  chain: "INPUT" | "OUTPUT";
  protocol: "tcp" | "udp" | "all";
  destination?: string;
  source?: string;
  dport?: number;
  sport?: number;
  target: "ACCEPT" | "DROP" | "REJECT";
  comment?: string;
}

export interface NetworkPolicyRuleset {
  /** Rules to apply (in order). */
  rules: IptablesRule[];
  /** Whether the container should use `--network=none`. */
  networkDisabled: boolean;
  /** Shell script that applies the rules via iptables. */
  script: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectNetworkScopes(scopes: RuntimeScope[]): NetworkScope[] {
  return scopes.filter(
    (s): s is NetworkScope =>
      s.permission === Permission.NetworkOutbound ||
      s.permission === Permission.NetworkInbound,
  );
}

function ruleToIptablesCmd(rule: IptablesRule): string {
  const parts = [`iptables -A ${rule.chain}`];

  if (rule.destination) parts.push(`-d ${rule.destination}`);
  if (rule.source) parts.push(`-s ${rule.source}`);

  if (rule.protocol !== "all") {
    parts.push(`-p ${rule.protocol}`);
    if (rule.dport) parts.push(`--dport ${rule.dport}`);
    if (rule.sport) parts.push(`--sport ${rule.sport}`);
  }

  parts.push(`-j ${rule.target}`);

  if (rule.comment) {
    parts.push(`-m comment --comment "${rule.comment}"`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the complete network policy ruleset from the runtime scopes.
 *
 * If no network scopes are present the container is started with
 * `--network=none`, completely isolating it from the network.  Otherwise,
 * iptables rules are generated to only allow traffic to/from the declared
 * hosts and ports.
 */
export function generateNetworkPolicy(
  scopes: RuntimeScope[],
): NetworkPolicyRuleset {
  const networkScopes = collectNetworkScopes(scopes);
  const rules: IptablesRule[] = [];

  // No network permissions → fully isolated
  if (networkScopes.length === 0) {
    return { rules: [], networkDisabled: true, script: "# network disabled" };
  }

  // Check for wildcard — no restrictions needed
  const allHosts = networkScopes.flatMap((s) => s.hosts);
  if (allHosts.includes("*")) {
    return {
      rules: [],
      networkDisabled: false,
      script: "# wildcard network access — no iptables restrictions",
    };
  }

  // Allow loopback
  rules.push({
    chain: "OUTPUT",
    protocol: "all",
    target: "ACCEPT",
    comment: "allow-loopback",
    destination: "127.0.0.0/8",
  });

  // Allow established connections
  rules.push({
    chain: "OUTPUT",
    protocol: "all",
    target: "ACCEPT",
    comment: "allow-established",
  });

  // Allow DNS (UDP + TCP port 53)
  rules.push(
    {
      chain: "OUTPUT",
      protocol: "udp",
      dport: 53,
      target: "ACCEPT",
      comment: "allow-dns-udp",
    },
    {
      chain: "OUTPUT",
      protocol: "tcp",
      dport: 53,
      target: "ACCEPT",
      comment: "allow-dns-tcp",
    },
  );

  // Per-scope rules
  for (const scope of networkScopes) {
    const chain =
      scope.permission === Permission.NetworkOutbound ? "OUTPUT" : "INPUT";

    for (const host of scope.hosts) {
      if (scope.ports && scope.ports.length > 0) {
        for (const port of scope.ports) {
          rules.push({
            chain,
            protocol: "tcp",
            destination: chain === "OUTPUT" ? host : undefined,
            source: chain === "INPUT" ? host : undefined,
            dport: port,
            target: "ACCEPT",
            comment: `allow-${host}:${port}`,
          });
        }
      } else {
        rules.push({
          chain,
          protocol: "all",
          destination: chain === "OUTPUT" ? host : undefined,
          source: chain === "INPUT" ? host : undefined,
          target: "ACCEPT",
          comment: `allow-${host}`,
        });
      }
    }
  }

  // Default drop for OUTPUT and INPUT
  const hasOutbound = networkScopes.some(
    (s) => s.permission === Permission.NetworkOutbound,
  );
  const hasInbound = networkScopes.some(
    (s) => s.permission === Permission.NetworkInbound,
  );

  if (hasOutbound) {
    rules.push({
      chain: "OUTPUT",
      protocol: "all",
      target: "DROP",
      comment: "default-drop-outbound",
    });
  }
  if (hasInbound) {
    rules.push({
      chain: "INPUT",
      protocol: "all",
      target: "DROP",
      comment: "default-drop-inbound",
    });
  }

  // Generate shell script
  const scriptLines = [
    "#!/bin/sh",
    "set -e",
    "",
    "# AgentBound network policy — generated by AgentBox",
    "# Flush existing rules",
    "iptables -F OUTPUT 2>/dev/null || true",
    "iptables -F INPUT 2>/dev/null || true",
    "",
    "# Allow established/related connections",
    "iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
    "iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
    "",
  ];

  for (const rule of rules) {
    if (rule.comment === "allow-established") continue; // handled above
    scriptLines.push(ruleToIptablesCmd(rule));
  }

  return {
    rules,
    networkDisabled: false,
    script: scriptLines.join("\n"),
  };
}

/**
 * Check whether a specific host:port combination is allowed by the policy.
 */
export function isHostAllowed(
  scopes: RuntimeScope[],
  host: string,
  port?: number,
): boolean {
  const networkScopes = collectNetworkScopes(scopes);
  if (networkScopes.length === 0) return false;

  for (const scope of networkScopes) {
    if (scope.hosts.includes("*")) return true;
    if (scope.hosts.includes(host)) {
      if (!port || !scope.ports || scope.ports.length === 0) return true;
      if (scope.ports.includes(port)) return true;
    }
  }

  return false;
}
