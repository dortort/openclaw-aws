/**
 * AgentBound — Access Control Framework for MCP Servers
 *
 * Public API surface.
 *
 * Based on: "Securing AI Agent Execution" (arXiv:2510.21236v2)
 *
 * Three pillars:
 *   1. AgentManifest  – Declarative access-control policy (JSON)
 *   2. AgentBox       – Policy enforcement engine (Docker sandbox)
 *   3. AgentManifestGen – Automated manifest generator (static analysis)
 */

// --- Core types & permission vocabulary ---
export {
  Permission,
  PermissionCategory,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_CATEGORY,
  SandboxState,
  ConsentDecision,
} from "./types.js";

export type {
  ManifestPermission,
  AgentManifest,
  FileScope,
  NetworkScope,
  SecretScope,
  EnvScope,
  ProcessScope,
  RuntimeScope,
  RuntimePolicy,
  SandboxInfo,
  ConsentRecord,
  ManifestGenAnalysis,
} from "./types.js";

// --- Manifest schema & validation ---
export { AGENT_MANIFEST_SCHEMA, validateManifest, extractPermissions } from "./manifest/schema.js";
export type { ValidationError, ValidationResult } from "./manifest/schema.js";

// --- Manifest loader ---
export {
  loadManifestFromFile,
  loadManifestFromString,
  loadManifestFromObject,
  serializeManifest,
  discoverManifest,
} from "./manifest/loader.js";

// --- AgentBox (sandbox orchestrator) ---
export { AgentBox } from "./sandbox/agentbox.js";
export type { AgentBoxOptions } from "./sandbox/agentbox.js";

// --- Container management ---
export { isDockerAvailable } from "./sandbox/container.js";
export type { ContainerConfig, ResourceLimits, ContainerHandle } from "./sandbox/container.js";

// --- Policy enforcement ---
export { generateNetworkPolicy, isHostAllowed } from "./sandbox/network-policy.js";
export type { IptablesRule, NetworkPolicyRuleset } from "./sandbox/network-policy.js";

export { generateFilesystemPolicy, isPathAllowed, validatePaths } from "./sandbox/filesystem-policy.js";
export type { BindMount, FilesystemPolicy } from "./sandbox/filesystem-policy.js";

export { generateEnvironmentPolicy, isEnvAllowed } from "./sandbox/environment-policy.js";
export type { EnvironmentPolicy } from "./sandbox/environment-policy.js";

// --- Consent management ---
export {
  AutoApproveConsentProvider,
  InteractiveConsentProvider,
  PolicyDrivenConsentProvider,
} from "./consent/consent-manager.js";
export type { ConsentProvider, ConsentRule } from "./consent/consent-manager.js";

// --- Manifest generation ---
export { generateManifest, generateManifestString } from "./generator/manifest-gen.js";
export type { ManifestGenOptions } from "./generator/manifest-gen.js";
