/**
 * AgentBound — Access Control Framework for MCP Servers
 *
 * Core types and permission vocabulary.
 *
 * Based on: "Securing AI Agent Execution" (arXiv:2510.21236v2)
 * by Bühler, Biagiola, Di Grazia, Salvaneschi (University of St. Gallen)
 *
 * The permission vocabulary (Table 1 of the paper) defines five categories
 * of agent-environment interactions: File, Network, Secret, Environment,
 * and Process.
 */

// ---------------------------------------------------------------------------
// Permission Vocabulary (Table 1)
// ---------------------------------------------------------------------------

/**
 * Every permission in the AgentBound vocabulary belongs to one of five
 * categories.  Each category groups related capabilities that an MCP server
 * may request in its AgentManifest.
 */
export enum PermissionCategory {
  File = "file",
  Network = "network",
  Secret = "secret",
  Environment = "environment",
  Process = "process",
}

/**
 * Concrete permission identifiers that can appear in an AgentManifest.
 *
 * These mirror the rows of Table 1 in the paper:
 *   file_read      – Read files from the local filesystem
 *   file_write     – Write / create files on the local filesystem
 *   file_delete    – Delete files from the local filesystem
 *   network_outbound – Initiate outbound network connections
 *   network_inbound  – Accept inbound network connections
 *   secret_read    – Read secrets (API keys, tokens, credentials)
 *   env_read       – Read host environment variables
 *   process_exec   – Spawn or interact with system processes
 */
export enum Permission {
  FileRead = "file_read",
  FileWrite = "file_write",
  FileDelete = "file_delete",
  NetworkOutbound = "network_outbound",
  NetworkInbound = "network_inbound",
  SecretRead = "secret_read",
  EnvRead = "env_read",
  ProcessExec = "process_exec",
}

/** Human-readable descriptions for each permission. */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  [Permission.FileRead]: "Read files from the local filesystem",
  [Permission.FileWrite]: "Write or create files on the local filesystem",
  [Permission.FileDelete]: "Delete files from the local filesystem",
  [Permission.NetworkOutbound]: "Initiate outbound network connections",
  [Permission.NetworkInbound]: "Accept inbound network connections",
  [Permission.SecretRead]: "Read secrets such as API keys, tokens, and credentials",
  [Permission.EnvRead]: "Read host environment variables",
  [Permission.ProcessExec]: "Spawn or interact with system processes",
};

/** Map each permission to its parent category. */
export const PERMISSION_CATEGORY: Record<Permission, PermissionCategory> = {
  [Permission.FileRead]: PermissionCategory.File,
  [Permission.FileWrite]: PermissionCategory.File,
  [Permission.FileDelete]: PermissionCategory.File,
  [Permission.NetworkOutbound]: PermissionCategory.Network,
  [Permission.NetworkInbound]: PermissionCategory.Network,
  [Permission.SecretRead]: PermissionCategory.Secret,
  [Permission.EnvRead]: PermissionCategory.Environment,
  [Permission.ProcessExec]: PermissionCategory.Process,
};

// ---------------------------------------------------------------------------
// AgentManifest
// ---------------------------------------------------------------------------

/**
 * A single permission entry inside an AgentManifest.
 *
 * Each entry declares a permission the MCP server requires together with
 * a human-readable justification that explains *why* the permission is
 * needed.  This justification aids both automated auditing and human review.
 */
export interface ManifestPermission {
  /** The permission identifier from the vocabulary. */
  permission: Permission;
  /** Free-text justification for why this permission is required. */
  justification: string;
}

/**
 * The AgentManifest — a declarative access-control policy that an MCP server
 * ships alongside its code.
 *
 * Inspired by the Android permission model, the manifest shifts the MCP
 * ecosystem from "trust-by-default" to least-privilege by making the
 * capabilities a server needs explicit and reviewable.
 */
export interface AgentManifest {
  /** Manifest schema version (semver). */
  version: string;

  /** Human-readable name of the MCP server. */
  name: string;

  /**
   * Short English description of the MCP server's purpose.
   * Aids human review of the declared permissions.
   */
  description: string;

  /** The list of permissions the server declares it needs. */
  permissions: ManifestPermission[];
}

// ---------------------------------------------------------------------------
// Runtime Permissions (scoped at launch time)
// ---------------------------------------------------------------------------

/**
 * At runtime the *generic* permissions declared in the manifest are refined
 * into *effective* runtime permissions with concrete scopes.
 *
 * For example, a generic `file_read` permission becomes a concrete scope
 * such as `/home/user/project/src` — restricting the server to only that
 * subtree.
 */

/** Scoped file-system permission. */
export interface FileScope {
  permission: Permission.FileRead | Permission.FileWrite | Permission.FileDelete;
  /** Absolute path(s) the server may access. */
  paths: string[];
}

/** Scoped network permission. */
export interface NetworkScope {
  permission: Permission.NetworkOutbound | Permission.NetworkInbound;
  /**
   * Allowed hosts / CIDRs.
   * An empty array means *no* hosts are allowed; `["*"]` means all.
   */
  hosts: string[];
  /** Optional port allowlist. Empty means all ports. */
  ports?: number[];
}

/** Scoped secret permission. */
export interface SecretScope {
  permission: Permission.SecretRead;
  /**
   * Names / patterns of secrets the server may read.
   * E.g. `["OPENAI_API_KEY", "GITHUB_TOKEN"]`.
   */
  names: string[];
}

/** Scoped environment-variable permission. */
export interface EnvScope {
  permission: Permission.EnvRead;
  /**
   * Names / patterns of environment variables the server may read.
   * E.g. `["HOME", "PATH", "NODE_ENV"]`.
   */
  names: string[];
}

/** Scoped process permission. */
export interface ProcessScope {
  permission: Permission.ProcessExec;
  /**
   * Allowed executable paths / names.
   * E.g. `["node", "python3", "/usr/bin/git"]`.
   */
  executables: string[];
}

/** Union of all scoped runtime permissions. */
export type RuntimeScope =
  | FileScope
  | NetworkScope
  | SecretScope
  | EnvScope
  | ProcessScope;

/**
 * The effective runtime policy that the AgentBox enforces for a single MCP
 * server.  It is derived from the AgentManifest after the user has granted
 * consent and refined each generic permission into a concrete scope.
 */
export interface RuntimePolicy {
  /** Reference to the originating manifest. */
  manifest: AgentManifest;
  /** Scoped permissions approved by the user. */
  scopes: RuntimeScope[];
}

// ---------------------------------------------------------------------------
// AgentBox types
// ---------------------------------------------------------------------------

/** Current lifecycle state of a sandboxed MCP server. */
export enum SandboxState {
  /** Container image is being built / pulled. */
  Preparing = "preparing",
  /** Waiting for user consent. */
  AwaitingConsent = "awaiting_consent",
  /** Container is running. */
  Running = "running",
  /** Server exited normally. */
  Stopped = "stopped",
  /** Server was terminated due to a policy violation. */
  Terminated = "terminated",
  /** An error prevented the server from starting. */
  Error = "error",
}

/** Metadata about a running (or recently stopped) sandboxed MCP server. */
export interface SandboxInfo {
  /** Unique identifier for this sandbox instance. */
  id: string;
  /** Docker container ID (set once the container is created). */
  containerId?: string;
  /** The runtime policy being enforced. */
  policy: RuntimePolicy;
  /** Current lifecycle state. */
  state: SandboxState;
  /** ISO-8601 timestamp when the sandbox was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the sandbox stopped (if applicable). */
  stoppedAt?: string;
  /** Human-readable reason for termination (if applicable). */
  terminationReason?: string;
}

// ---------------------------------------------------------------------------
// Consent types
// ---------------------------------------------------------------------------

/** Consent decision for a single permission scope. */
export enum ConsentDecision {
  /** The user approved the permission scope. */
  Approved = "approved",
  /** The user denied the permission scope. */
  Denied = "denied",
}

/** A recorded consent decision for a single runtime scope. */
export interface ConsentRecord {
  permission: Permission;
  decision: ConsentDecision;
  scope: RuntimeScope;
  /** ISO-8601 timestamp when the decision was recorded. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// AgentManifestGen types
// ---------------------------------------------------------------------------

/**
 * Intermediate output produced by the first stage of the AgentManifestGen
 * pipeline.  Includes raw analysis and justifications before the final
 * manifest is emitted.
 */
export interface ManifestGenAnalysis {
  /** Brief description inferred from the MCP server source code. */
  inferredDescription: string;
  /** Detected permissions with justifications and source evidence. */
  detectedPermissions: Array<{
    permission: Permission;
    justification: string;
    /** File paths / line references that evidence the permission need. */
    evidence: string[];
  }>;
  /** Overall confidence score (0–1). */
  confidence: number;
}
