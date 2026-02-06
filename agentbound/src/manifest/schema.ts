/**
 * AgentManifest JSON Schema definition.
 *
 * Provides both the JSON Schema object (for use with external validators such
 * as Ajv) and a built-in validation function that checks a parsed JSON value
 * against the schema and returns typed errors.
 */

import {
  type AgentManifest,
  type ManifestPermission,
  Permission,
} from "../types.js";

// ---------------------------------------------------------------------------
// JSON Schema (Draft 2020-12 compatible)
// ---------------------------------------------------------------------------

const PERMISSION_ENUM = Object.values(Permission);

/**
 * Canonical JSON Schema for an AgentManifest document.
 *
 * Usage with Ajv:
 *   const ajv = new Ajv();
 *   const validate = ajv.compile(AGENT_MANIFEST_SCHEMA);
 *   const valid = validate(data);
 */
export const AGENT_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agentbound.dev/schemas/agent-manifest.json",
  title: "AgentManifest",
  description:
    "Declarative access-control policy for an MCP server, as defined by the AgentBound framework.",
  type: "object" as const,
  required: ["version", "name", "description", "permissions"],
  additionalProperties: false,
  properties: {
    version: {
      type: "string" as const,
      description: "Manifest schema version (semver).",
      pattern: "^\\d+\\.\\d+\\.\\d+$",
    },
    name: {
      type: "string" as const,
      description: "Human-readable name of the MCP server.",
      minLength: 1,
      maxLength: 128,
    },
    description: {
      type: "string" as const,
      description:
        "Short English description of the MCP server's purpose to aid human review.",
      minLength: 1,
      maxLength: 1024,
    },
    permissions: {
      type: "array" as const,
      description:
        "List of permissions from the AgentBound vocabulary that this server requires.",
      items: {
        type: "object" as const,
        required: ["permission", "justification"],
        additionalProperties: false,
        properties: {
          permission: {
            type: "string" as const,
            enum: PERMISSION_ENUM,
            description: "Permission identifier from the AgentBound vocabulary.",
          },
          justification: {
            type: "string" as const,
            description:
              "Free-text justification explaining why this permission is required.",
            minLength: 1,
            maxLength: 512,
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Built-in validation (no external dependencies)
// ---------------------------------------------------------------------------

export interface ValidationError {
  /** JSON-pointer-style path to the offending field. */
  path: string;
  /** Human-readable error message. */
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** The parsed manifest (only set when `valid` is true). */
  manifest?: AgentManifest;
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Validate a raw (parsed JSON) value against the AgentManifest schema.
 *
 * This function performs structural, type, and semantic checks without
 * requiring any third-party validation library.
 */
export function validateManifest(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      valid: false,
      errors: [{ path: "/", message: "Manifest must be a JSON object." }],
    };
  }

  const obj = data as Record<string, unknown>;

  // --- version ---
  if (typeof obj.version !== "string") {
    errors.push({ path: "/version", message: "version must be a string." });
  } else if (!SEMVER_RE.test(obj.version)) {
    errors.push({
      path: "/version",
      message: "version must follow semver (e.g. 1.0.0).",
    });
  }

  // --- name ---
  if (typeof obj.name !== "string") {
    errors.push({ path: "/name", message: "name must be a string." });
  } else if (obj.name.length === 0 || obj.name.length > 128) {
    errors.push({
      path: "/name",
      message: "name must be between 1 and 128 characters.",
    });
  }

  // --- description ---
  if (typeof obj.description !== "string") {
    errors.push({
      path: "/description",
      message: "description must be a string.",
    });
  } else if (obj.description.length === 0 || obj.description.length > 1024) {
    errors.push({
      path: "/description",
      message: "description must be between 1 and 1024 characters.",
    });
  }

  // --- permissions ---
  if (!Array.isArray(obj.permissions)) {
    errors.push({
      path: "/permissions",
      message: "permissions must be an array.",
    });
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < obj.permissions.length; i++) {
      const entry = obj.permissions[i];
      const base = `/permissions/${i}`;

      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push({
          path: base,
          message: "Each permission entry must be an object.",
        });
        continue;
      }

      const e = entry as Record<string, unknown>;

      if (typeof e.permission !== "string") {
        errors.push({
          path: `${base}/permission`,
          message: "permission must be a string.",
        });
      } else if (!PERMISSION_ENUM.includes(e.permission as Permission)) {
        errors.push({
          path: `${base}/permission`,
          message: `Unknown permission "${e.permission}". Must be one of: ${PERMISSION_ENUM.join(", ")}.`,
        });
      } else if (seen.has(e.permission)) {
        errors.push({
          path: `${base}/permission`,
          message: `Duplicate permission "${e.permission}".`,
        });
      } else {
        seen.add(e.permission);
      }

      if (typeof e.justification !== "string") {
        errors.push({
          path: `${base}/justification`,
          message: "justification must be a string.",
        });
      } else if (e.justification.length === 0 || e.justification.length > 512) {
        errors.push({
          path: `${base}/justification`,
          message: "justification must be between 1 and 512 characters.",
        });
      }

      // Reject unknown keys
      const knownKeys = new Set(["permission", "justification"]);
      for (const key of Object.keys(e)) {
        if (!knownKeys.has(key)) {
          errors.push({
            path: `${base}/${key}`,
            message: `Unknown property "${key}".`,
          });
        }
      }
    }
  }

  // Reject unknown top-level keys
  const knownTopKeys = new Set(["version", "name", "description", "permissions"]);
  for (const key of Object.keys(obj)) {
    if (!knownTopKeys.has(key)) {
      errors.push({ path: `/${key}`, message: `Unknown property "${key}".` });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    manifest: obj as unknown as AgentManifest,
  };
}

/**
 * Convenience helper: returns the list of `Permission` values that a
 * validated manifest declares.
 */
export function extractPermissions(manifest: AgentManifest): Permission[] {
  return manifest.permissions.map((p: ManifestPermission) => p.permission);
}
