/**
 * Container Management
 *
 * Manages Docker containers used by AgentBox to sandbox MCP servers.
 * Each MCP server runs inside an isolated container whose mounts, network
 * rules, and environment are derived from the RuntimePolicy.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type { RuntimePolicy, RuntimeScope, FileScope, NetworkScope, EnvScope, SecretScope } from "../types.js";
import { Permission } from "../types.js";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerConfig {
  /** Docker image to use for the sandbox. */
  image: string;
  /** Name prefix for the container. */
  namePrefix?: string;
  /** Command + args to run inside the container (the MCP server). */
  command: string[];
  /** The runtime policy that defines mounts, network, and env rules. */
  policy: RuntimePolicy;
  /** Working directory inside the container. */
  workdir?: string;
  /** Optional resource limits. */
  limits?: ResourceLimits;
}

export interface ResourceLimits {
  /** Memory limit (e.g. "256m", "1g"). */
  memory?: string;
  /** CPU quota (e.g. "0.5" for half a core). */
  cpus?: string;
  /** Maximum number of open file descriptors. */
  nofile?: number;
  /** Maximum number of processes. */
  nproc?: number;
}

export interface ContainerHandle {
  id: string;
  containerId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Docker CLI helpers
// ---------------------------------------------------------------------------

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Check whether Docker is available on the host.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker("info", "--format", "{{.ServerVersion}}");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mount generation
// ---------------------------------------------------------------------------

function buildMountArgs(scopes: RuntimeScope[]): string[] {
  const args: string[] = [];

  for (const scope of scopes) {
    if (
      scope.permission === Permission.FileRead ||
      scope.permission === Permission.FileWrite ||
      scope.permission === Permission.FileDelete
    ) {
      const fs = scope as FileScope;
      const readOnly = scope.permission === Permission.FileRead;
      for (const hostPath of fs.paths) {
        // Mount host path into the same path inside the container
        const mode = readOnly ? "ro" : "rw";
        args.push("-v", `${hostPath}:${hostPath}:${mode}`);
      }
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Environment generation
// ---------------------------------------------------------------------------

function buildEnvArgs(scopes: RuntimeScope[]): string[] {
  const args: string[] = [];

  for (const scope of scopes) {
    if (scope.permission === Permission.EnvRead) {
      const env = scope as EnvScope;
      for (const name of env.names) {
        const value = process.env[name];
        if (value !== undefined) {
          args.push("-e", `${name}=${value}`);
        }
      }
    }
    if (scope.permission === Permission.SecretRead) {
      const sec = scope as SecretScope;
      for (const name of sec.names) {
        const value = process.env[name];
        if (value !== undefined) {
          args.push("-e", `${name}=${value}`);
        }
      }
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Resource-limit generation
// ---------------------------------------------------------------------------

function buildLimitArgs(limits?: ResourceLimits): string[] {
  const args: string[] = [];
  if (!limits) return args;

  if (limits.memory) args.push("--memory", limits.memory);
  if (limits.cpus) args.push("--cpus", limits.cpus);
  if (limits.nofile) args.push("--ulimit", `nofile=${limits.nofile}:${limits.nofile}`);
  if (limits.nproc) args.push("--ulimit", `nproc=${limits.nproc}:${limits.nproc}`);

  return args;
}

// ---------------------------------------------------------------------------
// Network policy generation (applied after container start)
// ---------------------------------------------------------------------------

/**
 * Determine whether any scope grants outbound network access.
 */
function hasNetworkOutbound(scopes: RuntimeScope[]): boolean {
  return scopes.some((s) => s.permission === Permission.NetworkOutbound);
}

/**
 * Determine whether any scope grants inbound network access.
 */
function hasNetworkInbound(scopes: RuntimeScope[]): boolean {
  return scopes.some((s) => s.permission === Permission.NetworkInbound);
}

/**
 * Collect the allowed hosts / CIDRs from NetworkScope entries.
 */
function collectNetworkHosts(scopes: RuntimeScope[]): string[] {
  const hosts: string[] = [];
  for (const scope of scopes) {
    if (
      scope.permission === Permission.NetworkOutbound ||
      scope.permission === Permission.NetworkInbound
    ) {
      hosts.push(...(scope as NetworkScope).hosts);
    }
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and start a sandboxed Docker container for an MCP server.
 */
export async function createSandboxContainer(
  config: ContainerConfig,
): Promise<ContainerHandle> {
  const id = randomUUID();
  const name = `${config.namePrefix ?? "agentbox"}-${id.slice(0, 8)}`;

  const args: string[] = ["run", "-d", "--name", name];

  // Isolation defaults: drop all capabilities, no-new-privileges
  args.push("--cap-drop=ALL", "--security-opt=no-new-privileges");

  // Network: if no outbound is granted, use `none` network mode
  const scopes = config.policy.scopes;
  if (!hasNetworkOutbound(scopes) && !hasNetworkInbound(scopes)) {
    args.push("--network=none");
  }

  // Mounts (filesystem scopes)
  args.push(...buildMountArgs(scopes));

  // Environment variables (env + secret scopes)
  args.push(...buildEnvArgs(scopes));

  // Resource limits
  args.push(...buildLimitArgs(config.limits));

  // Working directory
  if (config.workdir) {
    args.push("-w", config.workdir);
  }

  // Read-only root filesystem (MCP servers shouldn't write outside mounts)
  args.push("--read-only");

  // Tmpfs for /tmp so the server can still use temporary files
  args.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=64m");

  // Image
  args.push(config.image);

  // Command
  args.push(...config.command);

  const containerId = await docker(...args);

  return { id, containerId, name };
}

/**
 * Apply iptables-based network restrictions inside a running container.
 *
 * If the policy grants network access but restricts it to specific hosts,
 * this function installs iptables rules that DROP all traffic except to
 * the allowed destinations.
 */
export async function applyNetworkPolicy(
  containerId: string,
  scopes: RuntimeScope[],
): Promise<void> {
  const hosts = collectNetworkHosts(scopes);

  // Wildcard — no restrictions needed
  if (hosts.includes("*")) return;

  // No network scopes — container already started with --network=none
  if (hosts.length === 0) return;

  // Build iptables rules: default DROP, then ACCEPT for each host
  const rules: string[] = [
    // Allow established connections and loopback
    "iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
    "iptables -A OUTPUT -o lo -j ACCEPT",
    // Allow DNS resolution
    "iptables -A OUTPUT -p udp --dport 53 -j ACCEPT",
    "iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT",
  ];

  // Collect ports from scopes
  const allowedPorts = new Set<number>();
  for (const scope of scopes) {
    if (
      scope.permission === Permission.NetworkOutbound ||
      scope.permission === Permission.NetworkInbound
    ) {
      const ns = scope as NetworkScope;
      if (ns.ports) {
        for (const port of ns.ports) allowedPorts.add(port);
      }
    }
  }

  for (const host of hosts) {
    if (allowedPorts.size > 0) {
      for (const port of allowedPorts) {
        rules.push(
          `iptables -A OUTPUT -d ${host} -p tcp --dport ${port} -j ACCEPT`,
        );
      }
    } else {
      rules.push(`iptables -A OUTPUT -d ${host} -j ACCEPT`);
    }
  }

  // Default drop all other outbound
  rules.push("iptables -A OUTPUT -j DROP");

  const script = rules.join(" && ");
  await docker("exec", containerId, "sh", "-c", script);
}

/**
 * Stop and remove a sandbox container.
 */
export async function removeSandboxContainer(
  containerId: string,
): Promise<void> {
  try {
    await docker("stop", "-t", "10", containerId);
  } catch {
    // Container may already be stopped.
  }
  try {
    await docker("rm", "-f", containerId);
  } catch {
    // Container may already be removed.
  }
}

/**
 * Inspect a container and return its current status.
 */
export async function getContainerStatus(
  containerId: string,
): Promise<string> {
  return docker(
    "inspect",
    "--format",
    "{{.State.Status}}",
    containerId,
  );
}

/**
 * Retrieve the logs from a sandbox container.
 */
export async function getContainerLogs(
  containerId: string,
  tail?: number,
): Promise<string> {
  const args = ["logs"];
  if (tail !== undefined) args.push("--tail", String(tail));
  args.push(containerId);
  return docker(...args);
}
