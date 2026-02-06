# AgentBound

> **Experimental** — This module implements concepts from an academic research
> paper and is not yet production-hardened. APIs may change without notice.

Access control framework for [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers.
Provides declarative permission policies, sandbox enforcement via Docker
containers, and automated manifest generation through static analysis.

Inspired by: Bühler, C., Biagiola, M., Di Grazia, L., & Salvaneschi, G.
(2025). *Securing AI Agent Execution*. arXiv:2510.21236v2.
[\[paper\]](https://arxiv.org/abs/2510.21236)

## Overview

MCP servers execute with unrestricted access to host systems by default. AgentBound
shifts this to a least-privilege model through three pillars:

| Pillar | Purpose |
|---|---|
| **AgentManifest** | Declarative JSON policy that declares what permissions an MCP server needs |
| **AgentBox** | Enforcement engine that sandboxes servers in Docker containers |
| **AgentManifestGen** | Static-analysis tool that auto-generates manifests from source code |

### Architecture

```
 User ──▶ AI Agent ──▶ AgentBox ──▶ MCP Server ──▶ Environment
                          │
                    ┌─────┴──────┐
                    │ Read       │
                    │ manifest   │
                    │ ↓          │
                    │ Request    │
                    │ consent    │
                    │ ↓          │
                    │ Enforce    │
                    │ sandbox    │
                    └────────────┘
```

AgentBox reads the manifest, presents permissions to the user for consent,
then launches the server inside an isolated container that enforces:

- **Bind mounts** for filesystem scoping (read-only or read-write per path)
- **iptables rules** for network allowlists (per host/port)
- **Environment whitelists** for secrets and variables
- **Dropped capabilities**, read-only root filesystem, and no-new-privileges

## Permission vocabulary

Eight permissions across five categories (derived from Table 1 of the paper):

| Category | Permission | Description |
|---|---|---|
| File | `file_read` | Read files from the local filesystem |
| File | `file_write` | Write or create files on the local filesystem |
| File | `file_delete` | Delete files from the local filesystem |
| Network | `network_outbound` | Initiate outbound network connections |
| Network | `network_inbound` | Accept inbound network connections |
| Secret | `secret_read` | Read secrets (API keys, tokens, credentials) |
| Environment | `env_read` | Read host environment variables |
| Process | `process_exec` | Spawn or interact with system processes |

## Quick start

### Prerequisites

- Node.js >= 20
- Docker (for sandbox enforcement)

### Install and build

```bash
cd agentbound
npm install
npm run build
```

### CLI usage

```bash
# Show all commands
npx agentbound --help

# List the full permission vocabulary
npx agentbound permissions
```

## AgentManifest

A manifest is a JSON file that declares the permissions an MCP server requires.
It is intended to be bundled and distributed alongside the server.

### Format

```json
{
  "version": "1.0.0",
  "name": "filesystem-mcp-server",
  "description": "MCP server that provides file system operations within a workspace directory.",
  "permissions": [
    {
      "permission": "file_read",
      "justification": "Reads files from the workspace to serve content to the agent."
    },
    {
      "permission": "file_write",
      "justification": "Writes files in the workspace as directed by the agent."
    }
  ]
}
```

### Validate a manifest

```bash
npx agentbound validate examples/filesystem-server.manifest.json
```

Output:

```
Manifest is valid.

  Name:        filesystem-mcp-server
  Description: MCP server that provides file system operations ...
  Version:     1.0.0
  Permissions: 2
    - file_read: Read files from the local filesystem
    - file_write: Write or create files on the local filesystem
```

### Print the JSON Schema

```bash
npx agentbound schema
```

This outputs a JSON Schema (Draft 2020-12) that external tools such as Ajv can
consume for validation.

### Example manifests

See `examples/` for ready-made manifests:

| File | Server type | Permissions |
|---|---|---|
| `filesystem-server.manifest.json` | File system operations | `file_read`, `file_write` |
| `fetch-server.manifest.json` | URL fetching | `network_outbound` |
| `github-server.manifest.json` | GitHub API | `network_outbound`, `secret_read`, `env_read` |
| `code-execution-server.manifest.json` | Code runner | `process_exec`, `file_read`, `file_write` |

## AgentManifestGen

Auto-generate a manifest by scanning an MCP server's source code. The tool
uses a two-stage pipeline:

1. **Static analysis** — scans source files for API calls that indicate
   permission needs (filesystem I/O, HTTP clients, process spawning, env
   access, credential patterns).
2. **Assembly** — groups detections by permission, generates justifications
   and a confidence score, and emits a valid manifest.

### Generate a manifest

```bash
# Scan a directory and write the manifest to stdout
npx agentbound generate /path/to/mcp-server > agent-manifest.json

# Override the inferred name
npx agentbound generate /path/to/mcp-server --name my-server > agent-manifest.json
```

Example output (stderr shows analysis, stdout is the manifest):

```
Scanning /path/to/mcp-server for permission indicators...

Found 3 permission(s) (confidence: 75.0%)

  file_read: Detected file system read operations in 4 location(s).
    → src/tools/read.ts:12 — const data = await readFile(path, "utf-8");
    → src/tools/list.ts:8 — const entries = await readdir(dir);
  network_outbound: Detected outbound network connections in 2 location(s).
    → src/tools/fetch.ts:5 — const res = await fetch(url);
  env_read: Detected environment variable access in 1 location(s).
    → src/config.ts:3 — const apiUrl = process.env.API_URL;
```

The JSON manifest is written to stdout so it can be piped directly:

```bash
npx agentbound generate ./my-server | npx agentbound validate /dev/stdin
```

## AgentBox

The enforcement engine launches an MCP server inside a Docker container whose
capabilities are restricted to exactly what the manifest declares (and the user
approves).

### Launch a sandboxed server (interactive consent)

```bash
npx agentbound launch examples/filesystem-server.manifest.json \
  --image node:22-slim \
  --command node server.js
```

The CLI will prompt for each permission:

```
=== AgentBound Consent ===
MCP Server: filesystem-mcp-server
Description: MCP server that provides file system operations ...
Permissions requested: 2

--- Permission: file_read ---
  Category:      file
  Description:   Read files from the local filesystem
  Justification: Reads files from the workspace to serve content to the agent.

  Approve? [y/N]: y
  Allowed paths (comma-separated): /home/user/project/src

  [APPROVED] file_read → /home/user/project/src

--- Permission: file_write ---
  ...
```

### Programmatic usage

```typescript
import {
  AgentBox,
  AutoApproveConsentProvider,
  Permission,
  type FileScope,
  type RuntimeScope,
} from "agentbound";

const box = new AgentBox();

// Pre-define scopes (skips interactive consent)
const scopes: RuntimeScope[] = [
  {
    permission: Permission.FileRead,
    paths: ["/home/user/project/src"],
  } satisfies FileScope,
];

const sandbox = await box.launch({
  manifestPath: "agent-manifest.json",
  image: "node:22-slim",
  command: ["node", "server.js"],
  scopes,
});

console.log(sandbox.id);          // UUID
console.log(sandbox.state);       // "running"
console.log(sandbox.containerId); // Docker container ID

// Later: stop the sandbox
await box.stop(sandbox.id);
```

### Policy enforcement details

The container is created with these hardened defaults:

| Mechanism | Effect |
|---|---|
| `--cap-drop=ALL` | All Linux capabilities removed |
| `--security-opt=no-new-privileges` | Prevents privilege escalation |
| `--read-only` | Root filesystem is read-only |
| `--tmpfs /tmp:rw,noexec,nosuid,size=64m` | Writable `/tmp` with no exec |
| `--network=none` | Applied when no network permission is declared |
| Bind mounts (`:ro` / `:rw`) | Only declared paths are visible |
| Environment whitelist | Only declared variables are passed |

Network-scoped policies generate iptables rules inside the container:

```
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT   # DNS
iptables -A OUTPUT -d api.github.com -p tcp --dport 443 -j ACCEPT
iptables -A OUTPUT -j DROP                        # default deny
```

### Policy helpers

The framework also exports fine-grained policy utilities:

```typescript
import {
  generateFilesystemPolicy,
  generateNetworkPolicy,
  generateEnvironmentPolicy,
  isPathAllowed,
  isHostAllowed,
  isEnvAllowed,
} from "agentbound";

// Check if a path is allowed under the current scopes
isPathAllowed(scopes, "/home/user/project/src/index.ts", "read"); // true
isPathAllowed(scopes, "/etc/passwd", "read");                     // false

// Check network access
isHostAllowed(scopes, "api.github.com", 443);  // true or false
isEnvAllowed(scopes, "GITHUB_TOKEN");           // true or false

// Generate Docker CLI args for a policy
const fsPolicy = generateFilesystemPolicy(scopes);
console.log(fsPolicy.dockerArgs);
// ["--read-only", "--tmpfs", "/tmp:...", "-v", "/home/user/project/src:/home/user/project/src:ro"]
```

## Consent providers

Three built-in providers control how permissions are approved:

| Provider | Use case |
|---|---|
| `InteractiveConsentProvider` | CLI prompts — asks the user for each permission |
| `AutoApproveConsentProvider` | Programmatic — auto-approves with pre-configured scopes |
| `PolicyDrivenConsentProvider` | Rule-based — applies a list of allow/deny rules |

```typescript
import {
  PolicyDrivenConsentProvider,
  ConsentDecision,
  Permission,
} from "agentbound";

const consent = new PolicyDrivenConsentProvider([
  {
    permission: Permission.FileRead,
    decision: ConsentDecision.Approved,
    defaultScope: { permission: Permission.FileRead, paths: ["/workspace"] },
  },
  {
    permission: "*",
    decision: ConsentDecision.Denied,
  },
]);
```

## Project structure

```
agentbound/
├── src/
│   ├── types.ts                      # Permission vocabulary and core types
│   ├── index.ts                      # Public API exports
│   ├── cli.ts                        # CLI entry point
│   ├── manifest/
│   │   ├── schema.ts                 # JSON Schema + validation
│   │   └── loader.ts                 # File/string/object loading
│   ├── sandbox/
│   │   ├── agentbox.ts               # Orchestrator (load → consent → sandbox)
│   │   ├── container.ts              # Docker container management
│   │   ├── network-policy.ts         # iptables rule generation
│   │   ├── filesystem-policy.ts      # Bind mount generation
│   │   └── environment-policy.ts     # Environment variable whitelist
│   ├── consent/
│   │   └── consent-manager.ts        # Interactive, auto, policy providers
│   └── generator/
│       └── manifest-gen.ts           # Static analysis + manifest assembly
├── scripts/
│   └── sandbox-init.sh               # Container entrypoint
├── examples/                         # Example manifests
├── Dockerfile.sandbox                # Hardened base image for sandboxes
├── package.json
└── tsconfig.json
```

## Limitations

This is an **experimental** implementation. Known limitations:

- Static analysis (AgentManifestGen) uses regex pattern matching, not AST
  parsing. The paper reports 80.9% accuracy with an LLM-based approach; the
  regex-based approach here will have lower accuracy on complex codebases.
- Network policy enforcement via iptables requires `NET_ADMIN` capability
  inside the container, which may not be available in all environments. When
  unavailable, network isolation falls back to Docker's `--network=none`.
- The consent flow is currently terminal-based. GUI/web-based consent UIs
  can be built by implementing the `ConsentProvider` interface.
- Process execution restrictions (`process_exec`) are declared but not
  enforced via seccomp or AppArmor profiles in this version.

## References

Bühler, C., Biagiola, M., Di Grazia, L., & Salvaneschi, G. (2025).
*Securing AI Agent Execution*. University of St. Gallen.
arXiv:2510.21236v2. https://arxiv.org/abs/2510.21236

## License

MIT — see [LICENSE](../LICENSE).
