/**
 * AgentManifestGen — Automated Manifest Generator
 *
 * A two-stage pipeline that examines an MCP server's source code and
 * produces an AgentManifest automatically.
 *
 * From the paper:
 *   "We structured AgentManifestGen into a two-stage pipeline: given a
 *    list of allowed permissions, the manifest creator agent examines the
 *    given MCP server codebase and produces an intermediate manifest
 *    following a structured schema that includes a brief description of
 *    the server and a distinct set of permissions, each with a free-text
 *    justification."
 *
 * Stage 1 — Static Analysis:
 *   Scans source files for indicators of permission needs (fs calls,
 *   network imports, env access, process spawning, etc.).
 *
 * Stage 2 — Manifest Assembly:
 *   Combines the analysis results into a valid AgentManifest with
 *   justifications and confidence scores.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";

import type { AgentManifest, ManifestGenAnalysis } from "../types.js";
import { Permission } from "../types.js";
import { serializeManifest } from "../manifest/loader.js";

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

interface DetectionPattern {
  permission: Permission;
  /** Regex patterns that indicate the need for this permission. */
  patterns: RegExp[];
  /** Human-readable description of what was detected. */
  label: string;
}

const DETECTION_PATTERNS: DetectionPattern[] = [
  // --- File Read ---
  {
    permission: Permission.FileRead,
    patterns: [
      /\breadFile\b/,
      /\breadFileSync\b/,
      /\breaddir\b/,
      /\breaddirSync\b/,
      /\bcreateReadStream\b/,
      /\bfs\.read\b/,
      /\bfs\.access\b/,
      /\bfs\.stat\b/,
      /\bopen\s*\([^)]*['"]r['"]/,
      /\bwith\s+open\s*\([^)]*['"]r['"]/,
      /\bos\.listdir\b/,
      /\bos\.walk\b/,
      /\bglob\b/,
      /\bpathlib\b/,
    ],
    label: "File system read operations",
  },

  // --- File Write ---
  {
    permission: Permission.FileWrite,
    patterns: [
      /\bwriteFile\b/,
      /\bwriteFileSync\b/,
      /\bcreateWriteStream\b/,
      /\bfs\.write\b/,
      /\bfs\.appendFile\b/,
      /\bmkdir\b/,
      /\bmkdirSync\b/,
      /\bopen\s*\([^)]*['"]w['"]/,
      /\bwith\s+open\s*\([^)]*['"]w['"]/,
      /\bos\.makedirs\b/,
      /\bshutil\.copy\b/,
    ],
    label: "File system write operations",
  },

  // --- File Delete ---
  {
    permission: Permission.FileDelete,
    patterns: [
      /\bunlink\b/,
      /\bunlinkSync\b/,
      /\brmdir\b/,
      /\brmdirSync\b/,
      /\brm\s*\(/,
      /\bfs\.rm\b/,
      /\bos\.remove\b/,
      /\bos\.unlink\b/,
      /\bshutil\.rmtree\b/,
    ],
    label: "File system delete operations",
  },

  // --- Network Outbound ---
  {
    permission: Permission.NetworkOutbound,
    patterns: [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /\bhttp\.request\b/,
      /\bhttps\.request\b/,
      /\bhttp\.get\b/,
      /\bhttps\.get\b/,
      /\bnet\.connect\b/,
      /\bnet\.createConnection\b/,
      /\bWebSocket\b/,
      /\burllib\b/,
      /\brequests\.\b/,
      /\bhttpx\b/,
      /\baiohttp\b/,
      /\bsocket\.\b/,
      /\bXMLHttpRequest\b/,
    ],
    label: "Outbound network connections",
  },

  // --- Network Inbound ---
  {
    permission: Permission.NetworkInbound,
    patterns: [
      /\bcreateServer\b/,
      /\b\.listen\s*\(/,
      /\bnet\.createServer\b/,
      /\bhttp\.createServer\b/,
      /\bhttps\.createServer\b/,
      /\bexpress\s*\(\)/,
      /\bfastify\b/,
      /\bFlask\s*\(/,
      /\bDjango\b/,
      /\buvicorn\b/,
    ],
    label: "Inbound network listener",
  },

  // --- Secret Read ---
  {
    permission: Permission.SecretRead,
    patterns: [
      /\b[A-Z_]*API[_]?KEY\b/,
      /\b[A-Z_]*TOKEN\b/,
      /\b[A-Z_]*SECRET\b/,
      /\b[A-Z_]*PASSWORD\b/,
      /\b[A-Z_]*CREDENTIAL\b/,
      /\bkeytar\b/,
      /\bsecretManager\b/,
      /\bSecretsManager\b/,
      /\bvault\b/i,
      /\.env\b/,
      /\bdotenv\b/,
    ],
    label: "Secret / credential access",
  },

  // --- Environment Read ---
  {
    permission: Permission.EnvRead,
    patterns: [
      /\bprocess\.env\b/,
      /\bos\.environ\b/,
      /\bos\.getenv\b/,
      /\bEnvironment\.get\b/,
      /\bstd::env\b/,
      /\bgetenv\b/,
    ],
    label: "Environment variable access",
  },

  // --- Process Exec ---
  {
    permission: Permission.ProcessExec,
    patterns: [
      /\bchild_process\b/,
      /\bexecFile\b/,
      /\bexecSync\b/,
      /\bspawnSync\b/,
      /\bspawn\s*\(/,
      /\bexec\s*\(/,
      /\bsubprocess\b/,
      /\bPopen\b/,
      /\bos\.system\b/,
      /\bshelljs\b/,
      /\bexeca\b/,
    ],
    label: "Process execution",
  },
];

// ---------------------------------------------------------------------------
// Source code scanner
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
]);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "target",
]);

/**
 * Recursively collect source file paths under a directory.
 */
async function collectSourceFiles(
  dir: string,
  maxDepth = 8,
  depth = 0,
): Promise<string[]> {
  if (depth > maxDepth) return [];

  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...(await collectSourceFiles(fullPath, maxDepth, depth + 1)));
    } else if (entry.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Stage 1: Static Analysis
// ---------------------------------------------------------------------------

interface DetectionHit {
  permission: Permission;
  label: string;
  file: string;
  line: number;
  snippet: string;
}

async function analyzeFile(
  filePath: string,
): Promise<DetectionHit[]> {
  const hits: DetectionHit[] = [];
  let content: string;

  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");

  for (const pattern of DETECTION_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      for (const regex of pattern.patterns) {
        if (regex.test(lines[i])) {
          hits.push({
            permission: pattern.permission,
            label: pattern.label,
            file: filePath,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
          });
          break; // One hit per pattern per line is enough
        }
      }
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Stage 2: Manifest Assembly
// ---------------------------------------------------------------------------

function assembleAnalysis(
  hits: DetectionHit[],
  serverDir: string,
): ManifestGenAnalysis {
  // Group hits by permission
  const grouped = new Map<Permission, DetectionHit[]>();
  for (const hit of hits) {
    const existing = grouped.get(hit.permission) ?? [];
    existing.push(hit);
    grouped.set(hit.permission, existing);
  }

  const detectedPermissions: ManifestGenAnalysis["detectedPermissions"] = [];

  for (const [perm, permHits] of grouped) {
    const evidence = permHits.map(
      (h) => `${h.file}:${h.line} — ${h.snippet}`,
    );

    // Generate justification based on what was found
    const labels = [...new Set(permHits.map((h) => h.label))];
    const justification = `Detected ${labels.join(", ").toLowerCase()} in ${permHits.length} location(s).`;

    detectedPermissions.push({ permission: perm, justification, evidence });
  }

  // Confidence heuristic: higher if we have multiple hits from different files
  const uniqueFiles = new Set(hits.map((h) => h.file)).size;
  const confidence = Math.min(
    1,
    0.5 + uniqueFiles * 0.05 + detectedPermissions.length * 0.05,
  );

  return {
    inferredDescription: `MCP server located at ${basename(serverDir)}`,
    detectedPermissions,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ManifestGenOptions {
  /** Path to the MCP server source directory. */
  serverDirectory: string;
  /** Override the inferred server name. */
  name?: string;
  /** Override the inferred description. */
  description?: string;
  /** Maximum directory traversal depth. */
  maxDepth?: number;
}

/**
 * Run the full AgentManifestGen pipeline:
 *   Stage 1: Scan source files for permission indicators
 *   Stage 2: Assemble the analysis into a valid AgentManifest
 *
 * Returns both the analysis (with evidence) and the generated manifest.
 */
export async function generateManifest(
  options: ManifestGenOptions,
): Promise<{ analysis: ManifestGenAnalysis; manifest: AgentManifest }> {
  const { serverDirectory, maxDepth } = options;

  // Stage 1: Collect and analyze source files
  const sourceFiles = await collectSourceFiles(serverDirectory, maxDepth);
  if (sourceFiles.length === 0) {
    throw new Error(
      `No source files found in ${serverDirectory}. ` +
        "Ensure the directory contains source code files.",
    );
  }

  const allHits: DetectionHit[] = [];
  for (const file of sourceFiles) {
    allHits.push(...(await analyzeFile(file)));
  }

  // Stage 2: Assemble analysis
  const analysis = assembleAnalysis(allHits, serverDirectory);

  // Build the manifest
  const manifest: AgentManifest = {
    version: "1.0.0",
    name: options.name ?? basename(serverDirectory),
    description: options.description ?? analysis.inferredDescription,
    permissions: analysis.detectedPermissions.map((dp) => ({
      permission: dp.permission,
      justification: dp.justification,
    })),
  };

  return { analysis, manifest };
}

/**
 * Generate a manifest and return it as a formatted JSON string.
 */
export async function generateManifestString(
  options: ManifestGenOptions,
): Promise<string> {
  const { manifest } = await generateManifest(options);
  return serializeManifest(manifest);
}
