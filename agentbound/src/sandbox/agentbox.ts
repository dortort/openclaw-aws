/**
 * AgentBox — Policy Enforcement Engine
 *
 * The main orchestrator that brings together:
 *   1. Manifest loading & validation
 *   2. User consent flow
 *   3. Runtime scope refinement
 *   4. Container creation with enforced policies (fs, network, env)
 *   5. Lifecycle management (start, stop, inspect, logs)
 *
 * From the paper:
 *   "AgentBox serves as the policy enforcement engine that transforms the
 *    declarative intent of AgentManifest manifests into enforceable execution
 *    boundaries. [...] AgentBox encapsulates each MCP server inside an
 *    isolated container that enforces the declared manifest, without
 *    requiring any modification to the existing MCP server."
 */

import { randomUUID } from "node:crypto";

import type {
  AgentManifest,
  RuntimePolicy,
  RuntimeScope,
  SandboxInfo,
} from "../types.js";
import { SandboxState, Permission } from "../types.js";

import { loadManifestFromFile, discoverManifest } from "../manifest/loader.js";
import { extractPermissions } from "../manifest/schema.js";

import {
  createSandboxContainer,
  applyNetworkPolicy,
  removeSandboxContainer,
  getContainerStatus,
  getContainerLogs,
  isDockerAvailable,
  type ContainerConfig,
  type ContainerHandle,
  type ResourceLimits,
} from "./container.js";

import { generateNetworkPolicy } from "./network-policy.js";
import { generateFilesystemPolicy, validatePaths } from "./filesystem-policy.js";
import { generateEnvironmentPolicy } from "./environment-policy.js";

import type { ConsentProvider } from "../consent/consent-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentBoxOptions {
  /** Path to the AgentManifest file. If omitted, auto-discovery is used. */
  manifestPath?: string;

  /** Directory to search for the manifest (used by auto-discovery). */
  serverDirectory?: string;

  /** Docker image to run the MCP server in. */
  image: string;

  /** Command + args to start the MCP server inside the container. */
  command: string[];

  /** Working directory inside the container. */
  workdir?: string;

  /** Resource limits for the container. */
  limits?: ResourceLimits;

  /**
   * Runtime scopes that refine the generic manifest permissions.
   * If omitted, the consent provider will be used to collect scopes.
   */
  scopes?: RuntimeScope[];

  /** Consent provider for the interactive consent flow. */
  consentProvider?: ConsentProvider;

  /** Container name prefix. */
  namePrefix?: string;
}

// ---------------------------------------------------------------------------
// AgentBox class
// ---------------------------------------------------------------------------

export class AgentBox {
  private sandboxes = new Map<string, SandboxInfo>();

  /**
   * Launch an MCP server inside a sandboxed container.
   *
   * The full flow:
   *   1. Load and validate the AgentManifest
   *   2. Present permissions to the user for consent
   *   3. Refine generic permissions into concrete runtime scopes
   *   4. Create the container with enforced policies
   *   5. Apply network policy rules
   *   6. Return sandbox metadata
   */
  async launch(options: AgentBoxOptions): Promise<SandboxInfo> {
    // Ensure Docker is available
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is not available. AgentBox requires Docker to sandbox MCP servers.",
      );
    }

    const id = randomUUID();

    // Step 1: Load manifest
    const manifest = await this.loadManifest(options);

    const sandbox: SandboxInfo = {
      id,
      policy: { manifest, scopes: [] },
      state: SandboxState.Preparing,
      createdAt: new Date().toISOString(),
    };
    this.sandboxes.set(id, sandbox);

    try {
      // Step 2 & 3: Consent + scope refinement
      const scopes = await this.resolveScopes(manifest, options);
      sandbox.policy.scopes = scopes;

      // Step 4: Create container
      sandbox.state = SandboxState.Preparing;
      const handle = await this.createContainer(options, sandbox.policy);
      sandbox.containerId = handle.containerId;

      // Step 5: Apply network rules
      const networkPolicy = generateNetworkPolicy(scopes);
      if (!networkPolicy.networkDisabled && networkPolicy.rules.length > 0) {
        try {
          await applyNetworkPolicy(handle.containerId, scopes);
        } catch (err) {
          // iptables may not be available inside the container if
          // NET_ADMIN is not granted — that's acceptable since the
          // container was already started with restricted networking.
        }
      }

      sandbox.state = SandboxState.Running;
      return sandbox;
    } catch (err) {
      sandbox.state = SandboxState.Error;
      sandbox.terminationReason =
        err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Stop and remove a sandboxed MCP server.
   */
  async stop(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Unknown sandbox: ${sandboxId}`);

    if (sandbox.containerId) {
      await removeSandboxContainer(sandbox.containerId);
    }

    sandbox.state = SandboxState.Stopped;
    sandbox.stoppedAt = new Date().toISOString();
  }

  /**
   * Terminate a sandboxed MCP server due to a policy violation.
   */
  async terminate(sandboxId: string, reason: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Unknown sandbox: ${sandboxId}`);

    if (sandbox.containerId) {
      await removeSandboxContainer(sandbox.containerId);
    }

    sandbox.state = SandboxState.Terminated;
    sandbox.stoppedAt = new Date().toISOString();
    sandbox.terminationReason = reason;
  }

  /**
   * Get the current status of a sandbox.
   */
  async status(sandboxId: string): Promise<SandboxInfo> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Unknown sandbox: ${sandboxId}`);

    // Refresh state from Docker if the container is supposed to be running
    if (sandbox.containerId && sandbox.state === SandboxState.Running) {
      try {
        const dockerState = await getContainerStatus(sandbox.containerId);
        if (dockerState === "exited") {
          sandbox.state = SandboxState.Stopped;
          sandbox.stoppedAt = new Date().toISOString();
        }
      } catch {
        // Container may have been removed externally
        sandbox.state = SandboxState.Stopped;
        sandbox.stoppedAt = new Date().toISOString();
      }
    }

    return sandbox;
  }

  /**
   * Retrieve logs from a sandboxed MCP server.
   */
  async logs(sandboxId: string, tail?: number): Promise<string> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Unknown sandbox: ${sandboxId}`);
    if (!sandbox.containerId) return "";

    return getContainerLogs(sandbox.containerId, tail);
  }

  /**
   * List all tracked sandboxes.
   */
  list(): SandboxInfo[] {
    return Array.from(this.sandboxes.values());
  }

  /**
   * Validate a manifest without launching a sandbox.
   * Returns the loaded manifest and any filesystem-path warnings.
   */
  async validate(options: {
    manifestPath?: string;
    serverDirectory?: string;
    scopes?: RuntimeScope[];
  }): Promise<{
    manifest: AgentManifest;
    missingPaths: string[];
    permissions: Permission[];
  }> {
    const manifest = await this.loadManifest(options);
    const permissions = extractPermissions(manifest);
    const missingPaths = options.scopes
      ? await validatePaths(options.scopes)
      : [];
    return { manifest, missingPaths, permissions };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async loadManifest(options: {
    manifestPath?: string;
    serverDirectory?: string;
  }): Promise<AgentManifest> {
    let manifestPath = options.manifestPath;

    if (!manifestPath && options.serverDirectory) {
      manifestPath = await discoverManifest(options.serverDirectory) ?? undefined;
    }

    if (!manifestPath) {
      throw new Error(
        "No manifest path provided and auto-discovery did not find a manifest. " +
          "Expected one of: agentbound.manifest.json, agent-manifest.json, manifest.json",
      );
    }

    const result = await loadManifestFromFile(manifestPath);
    if (!result.valid || !result.manifest) {
      const msg = result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
      throw new Error(`Invalid AgentManifest at ${manifestPath}:\n${msg}`);
    }

    return result.manifest;
  }

  private async resolveScopes(
    manifest: AgentManifest,
    options: AgentBoxOptions,
  ): Promise<RuntimeScope[]> {
    // If scopes are already provided, use them directly
    if (options.scopes && options.scopes.length > 0) {
      return options.scopes;
    }

    // Use the consent provider to collect scopes interactively
    if (options.consentProvider) {
      return options.consentProvider.requestConsent(manifest);
    }

    // No scopes and no consent provider — use empty scopes (locked down)
    return [];
  }

  private async createContainer(
    options: AgentBoxOptions,
    policy: RuntimePolicy,
  ): Promise<ContainerHandle> {
    const config: ContainerConfig = {
      image: options.image,
      command: options.command,
      policy,
      namePrefix: options.namePrefix,
      workdir: options.workdir,
      limits: options.limits,
    };

    return createSandboxContainer(config);
  }
}
