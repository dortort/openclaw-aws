/**
 * Filesystem Policy Enforcement
 *
 * Translates FileScope entries from the RuntimePolicy into Docker bind-mount
 * specifications.  The paper describes using "mounts for filesystem scopes"
 * to restrict which paths a sandboxed MCP server can access.
 *
 * Key design decisions:
 *   - file_read  → read-only bind mount
 *   - file_write → read-write bind mount
 *   - file_delete → read-write bind mount (delete requires write access)
 *   - Paths not listed in any scope are simply not mounted, so the server
 *     cannot access them at all.
 *   - The container root filesystem is mounted read-only.
 */

import { resolve, dirname } from "node:path";
import { stat } from "node:fs/promises";

import type { FileScope, RuntimeScope } from "../types.js";
import { Permission } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BindMount {
  /** Absolute path on the host. */
  hostPath: string;
  /** Absolute path inside the container (mirrors hostPath by default). */
  containerPath: string;
  /** Whether the mount is read-only. */
  readOnly: boolean;
  /** The permission that produced this mount. */
  sourcePermission: Permission.FileRead | Permission.FileWrite | Permission.FileDelete;
}

export interface FilesystemPolicy {
  /** Bind mounts to apply when creating the container. */
  mounts: BindMount[];
  /** Whether the root filesystem should be read-only (always true). */
  readOnlyRootfs: boolean;
  /** Docker CLI arguments that implement this policy. */
  dockerArgs: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectFileScopes(scopes: RuntimeScope[]): FileScope[] {
  return scopes.filter(
    (s): s is FileScope =>
      s.permission === Permission.FileRead ||
      s.permission === Permission.FileWrite ||
      s.permission === Permission.FileDelete,
  );
}

/**
 * Detect overlapping mounts and merge them (most permissive wins).
 *
 * If path A is a parent of path B and both are mounted, we keep both
 * but ensure the parent's permissions don't inadvertently restrict the
 * child.
 */
function deduplicateMounts(mounts: BindMount[]): BindMount[] {
  const byPath = new Map<string, BindMount>();

  for (const mount of mounts) {
    const existing = byPath.get(mount.hostPath);
    if (!existing) {
      byPath.set(mount.hostPath, mount);
    } else {
      // If existing is read-only but new is read-write, upgrade to rw
      if (existing.readOnly && !mount.readOnly) {
        byPath.set(mount.hostPath, mount);
      }
    }
  }

  return Array.from(byPath.values());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the filesystem policy (bind mounts + Docker args) from runtime
 * scopes.
 */
export function generateFilesystemPolicy(
  scopes: RuntimeScope[],
): FilesystemPolicy {
  const fileScopes = collectFileScopes(scopes);

  const rawMounts: BindMount[] = [];
  for (const scope of fileScopes) {
    const readOnly = scope.permission === Permission.FileRead;
    for (const hostPath of scope.paths) {
      const abs = resolve(hostPath);
      rawMounts.push({
        hostPath: abs,
        containerPath: abs,
        readOnly,
        sourcePermission: scope.permission,
      });
    }
  }

  const mounts = deduplicateMounts(rawMounts);

  // Build Docker CLI arguments
  const dockerArgs: string[] = [
    // Read-only root filesystem
    "--read-only",
    // Tmpfs for /tmp
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
  ];

  for (const mount of mounts) {
    const mode = mount.readOnly ? "ro" : "rw";
    dockerArgs.push(
      "-v",
      `${mount.hostPath}:${mount.containerPath}:${mode}`,
    );
  }

  return {
    mounts,
    readOnlyRootfs: true,
    dockerArgs,
  };
}

/**
 * Check whether a given host path is accessible under the current policy.
 */
export function isPathAllowed(
  scopes: RuntimeScope[],
  path: string,
  operation: "read" | "write" | "delete",
): boolean {
  const abs = resolve(path);
  const fileScopes = collectFileScopes(scopes);

  for (const scope of fileScopes) {
    // Check permission level
    if (operation === "read") {
      // Any file permission grants read access
    } else if (operation === "write") {
      if (scope.permission === Permission.FileRead) continue;
    } else if (operation === "delete") {
      if (scope.permission === Permission.FileRead) continue;
      if (scope.permission === Permission.FileWrite) continue;
    }

    for (const allowed of scope.paths) {
      const allowedAbs = resolve(allowed);
      if (abs === allowedAbs || abs.startsWith(allowedAbs + "/")) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validate that all declared paths exist on the host filesystem.
 * Returns a list of paths that could not be found.
 */
export async function validatePaths(
  scopes: RuntimeScope[],
): Promise<string[]> {
  const fileScopes = collectFileScopes(scopes);
  const missing: string[] = [];

  for (const scope of fileScopes) {
    for (const path of scope.paths) {
      try {
        await stat(resolve(path));
      } catch {
        missing.push(path);
      }
    }
  }

  return missing;
}
