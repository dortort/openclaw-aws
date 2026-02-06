/**
 * Consent Manager
 *
 * Implements the user-consent flow described in the paper:
 *   "At runtime, the agent accesses the manifest, requests user consent
 *    for the declared permissions, and launches the server within the
 *    sandbox."
 *
 * Provides both a programmatic interface (ConsentProvider) and a built-in
 * interactive CLI implementation that prompts the user for each permission
 * scope.
 */

import { createInterface } from "node:readline";

import type {
  AgentManifest,
  RuntimeScope,
  ConsentRecord,
  ManifestPermission,
  FileScope,
  NetworkScope,
  SecretScope,
  EnvScope,
  ProcessScope,
} from "../types.js";
import {
  Permission,
  ConsentDecision,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_CATEGORY,
} from "../types.js";

// ---------------------------------------------------------------------------
// Consent provider interface
// ---------------------------------------------------------------------------

/**
 * A ConsentProvider presents the manifest permissions to the user and
 * collects their consent decisions with concrete runtime scopes.
 *
 * Implementations may be interactive (CLI prompts), GUI-based, or
 * policy-driven (auto-approve based on rules).
 */
export interface ConsentProvider {
  /**
   * Present the manifest to the user and collect consent.
   * Returns the list of approved runtime scopes.
   * Throws if the user declines all permissions.
   */
  requestConsent(manifest: AgentManifest): Promise<RuntimeScope[]>;
}

// ---------------------------------------------------------------------------
// Auto-approve provider (for programmatic / test use)
// ---------------------------------------------------------------------------

/**
 * A ConsentProvider that automatically approves all permissions with
 * pre-configured scopes.
 */
export class AutoApproveConsentProvider implements ConsentProvider {
  constructor(private defaultScopes: RuntimeScope[]) {}

  async requestConsent(_manifest: AgentManifest): Promise<RuntimeScope[]> {
    return this.defaultScopes;
  }
}

// ---------------------------------------------------------------------------
// Interactive CLI provider
// ---------------------------------------------------------------------------

/**
 * A ConsentProvider that prompts the user interactively on the terminal.
 *
 * For each permission in the manifest, the user is shown:
 *   - The permission name and description
 *   - The server's justification for needing it
 *
 * The user can then approve or deny each permission, and (where
 * applicable) provide scoping details such as allowed paths or hosts.
 */
export class InteractiveConsentProvider implements ConsentProvider {
  private records: ConsentRecord[] = [];

  async requestConsent(manifest: AgentManifest): Promise<RuntimeScope[]> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const ask = (question: string): Promise<string> =>
      new Promise((resolve) => rl.question(question, resolve));

    const scopes: RuntimeScope[] = [];

    console.error("\n=== AgentBound Consent ===");
    console.error(`MCP Server: ${manifest.name}`);
    console.error(`Description: ${manifest.description}`);
    console.error(`Permissions requested: ${manifest.permissions.length}\n`);

    for (const entry of manifest.permissions) {
      console.error(`--- Permission: ${entry.permission} ---`);
      console.error(`  Category:      ${PERMISSION_CATEGORY[entry.permission]}`);
      console.error(`  Description:   ${PERMISSION_DESCRIPTIONS[entry.permission]}`);
      console.error(`  Justification: ${entry.justification}`);

      const answer = await ask("\n  Approve? [y/N]: ");
      const approved = answer.trim().toLowerCase() === "y";

      if (approved) {
        const scope = await this.collectScope(entry, ask);
        if (scope) {
          scopes.push(scope);
          this.records.push({
            permission: entry.permission,
            decision: ConsentDecision.Approved,
            scope,
            timestamp: new Date().toISOString(),
          });
        }
      } else {
        this.records.push({
          permission: entry.permission,
          decision: ConsentDecision.Denied,
          scope: { permission: entry.permission } as RuntimeScope,
          timestamp: new Date().toISOString(),
        });
        console.error(`  [DENIED] ${entry.permission}\n`);
      }
    }

    rl.close();

    if (scopes.length === 0) {
      throw new Error(
        "All permissions denied. The MCP server cannot run without any permissions.",
      );
    }

    console.error(`\nApproved ${scopes.length} of ${manifest.permissions.length} permissions.\n`);
    return scopes;
  }

  /** Return the full list of consent records from the last session. */
  getRecords(): ConsentRecord[] {
    return [...this.records];
  }

  // -----------------------------------------------------------------------
  // Scope collection helpers
  // -----------------------------------------------------------------------

  private async collectScope(
    entry: ManifestPermission,
    ask: (q: string) => Promise<string>,
  ): Promise<RuntimeScope | null> {
    switch (entry.permission) {
      case Permission.FileRead:
      case Permission.FileWrite:
      case Permission.FileDelete: {
        const raw = await ask(
          "  Allowed paths (comma-separated, e.g. /home/user/project): ",
        );
        const paths = raw
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        if (paths.length === 0) {
          console.error("  [DENIED] No paths provided.\n");
          return null;
        }
        console.error(`  [APPROVED] ${entry.permission} → ${paths.join(", ")}\n`);
        return { permission: entry.permission, paths } as FileScope;
      }

      case Permission.NetworkOutbound:
      case Permission.NetworkInbound: {
        const rawHosts = await ask(
          "  Allowed hosts (comma-separated, e.g. api.example.com, or * for all): ",
        );
        const hosts = rawHosts
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean);
        if (hosts.length === 0) {
          console.error("  [DENIED] No hosts provided.\n");
          return null;
        }
        const rawPorts = await ask(
          "  Allowed ports (comma-separated, or empty for all): ",
        );
        const ports = rawPorts
          .split(",")
          .map((p) => parseInt(p.trim(), 10))
          .filter((p) => !isNaN(p));
        console.error(
          `  [APPROVED] ${entry.permission} → hosts: ${hosts.join(", ")}` +
            (ports.length > 0 ? `, ports: ${ports.join(", ")}` : "") +
            "\n",
        );
        return {
          permission: entry.permission,
          hosts,
          ports: ports.length > 0 ? ports : undefined,
        } as NetworkScope;
      }

      case Permission.SecretRead: {
        const raw = await ask(
          "  Allowed secret names (comma-separated, e.g. OPENAI_API_KEY): ",
        );
        const names = raw
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        if (names.length === 0) {
          console.error("  [DENIED] No secrets provided.\n");
          return null;
        }
        console.error(`  [APPROVED] ${entry.permission} → ${names.join(", ")}\n`);
        return { permission: entry.permission, names } as SecretScope;
      }

      case Permission.EnvRead: {
        const raw = await ask(
          "  Allowed env vars (comma-separated, e.g. HOME, PATH, NODE_*): ",
        );
        const names = raw
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        if (names.length === 0) {
          console.error("  [DENIED] No env vars provided.\n");
          return null;
        }
        console.error(`  [APPROVED] ${entry.permission} → ${names.join(", ")}\n`);
        return { permission: entry.permission, names } as EnvScope;
      }

      case Permission.ProcessExec: {
        const raw = await ask(
          "  Allowed executables (comma-separated, e.g. node, python3, /usr/bin/git): ",
        );
        const executables = raw
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
        if (executables.length === 0) {
          console.error("  [DENIED] No executables provided.\n");
          return null;
        }
        console.error(`  [APPROVED] ${entry.permission} → ${executables.join(", ")}\n`);
        return { permission: entry.permission, executables } as ProcessScope;
      }

      default:
        console.error(`  [SKIP] Unknown permission: ${entry.permission}\n`);
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Policy-driven provider
// ---------------------------------------------------------------------------

/**
 * A ConsentProvider that applies a set of pre-defined rules to
 * automatically approve or deny permissions based on patterns.
 */
export interface ConsentRule {
  /** Permission to match. Use `"*"` to match all. */
  permission: Permission | "*";
  /** Decision to apply. */
  decision: ConsentDecision;
  /** Default scope to assign if approved. */
  defaultScope?: RuntimeScope;
}

export class PolicyDrivenConsentProvider implements ConsentProvider {
  constructor(private rules: ConsentRule[]) {}

  async requestConsent(manifest: AgentManifest): Promise<RuntimeScope[]> {
    const scopes: RuntimeScope[] = [];

    for (const entry of manifest.permissions) {
      const rule = this.rules.find(
        (r) => r.permission === entry.permission || r.permission === "*",
      );

      if (rule && rule.decision === ConsentDecision.Approved && rule.defaultScope) {
        scopes.push(rule.defaultScope);
      }
      // If denied or no rule, skip
    }

    return scopes;
  }
}
