/**
 * AgentManifest Loader
 *
 * Reads, parses, and validates AgentManifest files from disk or from a
 * raw string / object.  Supports the JSON manifest format defined by the
 * AgentBound framework.
 */

import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

import type { AgentManifest } from "../types.js";
import {
  validateManifest,
  type ValidationResult,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate an AgentManifest from a file path.
 *
 * The function resolves the path, reads the file, parses JSON, and runs the
 * built-in validator.  Throws on I/O errors; validation failures are
 * returned in the result object.
 *
 * @param filePath  Absolute or relative path to a `.json` manifest file.
 */
export async function loadManifestFromFile(
  filePath: string,
): Promise<ValidationResult> {
  const absolute = resolve(filePath);
  const ext = extname(absolute).toLowerCase();

  if (ext !== ".json") {
    return {
      valid: false,
      errors: [
        {
          path: "/",
          message: `Unsupported file extension "${ext}". Only .json manifests are supported.`,
        },
      ],
    };
  }

  const raw = await readFile(absolute, "utf-8");
  return loadManifestFromString(raw);
}

/**
 * Parse and validate an AgentManifest from a raw JSON string.
 */
export function loadManifestFromString(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          path: "/",
          message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  return validateManifest(parsed);
}

/**
 * Validate a pre-parsed value as an AgentManifest.
 */
export function loadManifestFromObject(data: unknown): ValidationResult {
  return validateManifest(data);
}

/**
 * Serialize an AgentManifest to a formatted JSON string.
 */
export function serializeManifest(manifest: AgentManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Look for a manifest file using conventional names in a given directory.
 *
 * Searches for (in order):
 *   1. `agentbound.manifest.json`
 *   2. `agent-manifest.json`
 *   3. `manifest.json`
 *
 * Returns the first match, or `null` if none found.
 */
export async function discoverManifest(
  directory: string,
): Promise<string | null> {
  const candidates = [
    "agentbound.manifest.json",
    "agent-manifest.json",
    "manifest.json",
  ];

  for (const name of candidates) {
    const candidate = resolve(directory, name);
    try {
      await readFile(candidate, "utf-8");
      return candidate;
    } catch {
      // File doesn't exist or is unreadable — try next candidate.
    }
  }

  return null;
}
