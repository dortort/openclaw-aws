/**
 * Environment Variable Policy Enforcement
 *
 * Translates EnvScope and SecretScope entries from the RuntimePolicy into
 * a whitelist of environment variables that are passed to the sandbox
 * container.  The paper describes using "environment whitelists (for secrets
 * and variables)" as one of the containerization primitives.
 *
 * Design:
 *   - Only variables explicitly listed in the scope are forwarded.
 *   - Variables not present on the host are silently omitted.
 *   - Glob patterns in names are expanded against the current env.
 */

import type { EnvScope, SecretScope, RuntimeScope } from "../types.js";
import { Permission } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvironmentPolicy {
  /** Name=value pairs to pass to the container. */
  variables: Record<string, string>;
  /** Names that were requested but not found on the host. */
  missing: string[];
  /** Docker CLI arguments (`-e NAME=VALUE`) implementing this policy. */
  dockerArgs: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectEnvScopes(scopes: RuntimeScope[]): EnvScope[] {
  return scopes.filter(
    (s): s is EnvScope => s.permission === Permission.EnvRead,
  );
}

function collectSecretScopes(scopes: RuntimeScope[]): SecretScope[] {
  return scopes.filter(
    (s): s is SecretScope => s.permission === Permission.SecretRead,
  );
}

/**
 * Simple glob matching for environment variable names.
 * Supports `*` as a wildcard for zero or more characters.
 */
function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;

  const regex = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return regex.test(name);
}

/**
 * Expand a list of name patterns against the current environment.
 */
function expandPatterns(
  patterns: string[],
  env: Record<string, string | undefined>,
): { resolved: Record<string, string>; missing: string[] } {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      // Glob: match against all env keys
      let matched = false;
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && matchesPattern(key, pattern)) {
          resolved[key] = value;
          matched = true;
        }
      }
      if (!matched) missing.push(pattern);
    } else {
      // Exact match
      const value = env[pattern];
      if (value !== undefined) {
        resolved[pattern] = value;
      } else {
        missing.push(pattern);
      }
    }
  }

  return { resolved, missing };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the environment policy from runtime scopes.
 *
 * @param scopes Runtime scopes from the policy.
 * @param env    Environment to resolve against (defaults to `process.env`).
 */
export function generateEnvironmentPolicy(
  scopes: RuntimeScope[],
  env: Record<string, string | undefined> = process.env,
): EnvironmentPolicy {
  const envScopes = collectEnvScopes(scopes);
  const secretScopes = collectSecretScopes(scopes);

  const allPatterns = [
    ...envScopes.flatMap((s) => s.names),
    ...secretScopes.flatMap((s) => s.names),
  ];

  const { resolved, missing } = expandPatterns(allPatterns, env);

  // Build Docker CLI arguments
  const dockerArgs: string[] = [];
  for (const [name, value] of Object.entries(resolved)) {
    dockerArgs.push("-e", `${name}=${value}`);
  }

  return { variables: resolved, missing, dockerArgs };
}

/**
 * Check whether a specific environment variable is allowed by the policy.
 */
export function isEnvAllowed(
  scopes: RuntimeScope[],
  name: string,
): boolean {
  const envScopes = collectEnvScopes(scopes);
  const secretScopes = collectSecretScopes(scopes);

  const allPatterns = [
    ...envScopes.flatMap((s) => s.names),
    ...secretScopes.flatMap((s) => s.names),
  ];

  return allPatterns.some((pattern) => matchesPattern(name, pattern));
}
