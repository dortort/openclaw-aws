#!/usr/bin/env node

/**
 * AgentBound CLI
 *
 * Commands:
 *   validate <manifest>     Validate an AgentManifest file
 *   generate <directory>    Generate a manifest from MCP server source code
 *   launch <manifest>       Launch an MCP server in a sandbox
 *   inspect <sandbox-id>    Inspect a running sandbox
 *   stop <sandbox-id>       Stop a sandbox
 *   schema                  Print the AgentManifest JSON Schema
 */

import { resolve } from "node:path";

import { loadManifestFromFile, serializeManifest } from "./manifest/loader.js";
import { AGENT_MANIFEST_SCHEMA, extractPermissions } from "./manifest/schema.js";
import { generateManifest } from "./generator/manifest-gen.js";
import { AgentBox } from "./sandbox/agentbox.js";
import { InteractiveConsentProvider } from "./consent/consent-manager.js";
import { PERMISSION_DESCRIPTIONS } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`
AgentBound — Access Control Framework for MCP Servers

Usage: agentbound <command> [options]

Commands:
  validate <manifest>              Validate an AgentManifest JSON file
  generate <directory> [--name N]  Generate a manifest from source code
  launch <manifest> --image IMG    Launch MCP server in a sandboxed container
       --command CMD [ARGS...]
  inspect <sandbox-id>             Inspect a running sandbox
  stop <sandbox-id>                Stop a running sandbox
  schema                           Print the AgentManifest JSON Schema
  permissions                      List all permissions in the vocabulary

Options:
  --help, -h    Show this help message
  --version     Show version
`);
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdValidate(manifestPath: string): Promise<void> {
  const result = await loadManifestFromFile(resolve(manifestPath));

  if (!result.valid) {
    console.error("Manifest validation FAILED:\n");
    for (const err of result.errors) {
      console.error(`  ${err.path}: ${err.message}`);
    }
    process.exit(1);
  }

  const manifest = result.manifest!;
  const perms = extractPermissions(manifest);

  console.log("Manifest is valid.\n");
  console.log(`  Name:        ${manifest.name}`);
  console.log(`  Description: ${manifest.description}`);
  console.log(`  Version:     ${manifest.version}`);
  console.log(`  Permissions: ${perms.length}`);
  for (const p of perms) {
    console.log(`    - ${p}: ${PERMISSION_DESCRIPTIONS[p]}`);
  }
}

async function cmdGenerate(
  directory: string,
  name?: string,
): Promise<void> {
  console.error(`Scanning ${directory} for permission indicators...\n`);

  const { analysis, manifest } = await generateManifest({
    serverDirectory: resolve(directory),
    name,
  });

  console.error(
    `Found ${analysis.detectedPermissions.length} permission(s) ` +
      `(confidence: ${(analysis.confidence * 100).toFixed(1)}%)\n`,
  );

  for (const dp of analysis.detectedPermissions) {
    console.error(`  ${dp.permission}: ${dp.justification}`);
    for (const ev of dp.evidence.slice(0, 3)) {
      console.error(`    → ${ev}`);
    }
    if (dp.evidence.length > 3) {
      console.error(`    ... and ${dp.evidence.length - 3} more`);
    }
  }

  console.error("");

  // Output the manifest to stdout so it can be piped to a file
  console.log(serializeManifest(manifest));
}

async function cmdLaunch(
  manifestPath: string,
  image: string,
  command: string[],
): Promise<void> {
  const box = new AgentBox();
  const consent = new InteractiveConsentProvider();

  console.error(`Launching MCP server from manifest: ${manifestPath}`);
  console.error(`Image: ${image}`);
  console.error(`Command: ${command.join(" ")}\n`);

  const sandbox = await box.launch({
    manifestPath: resolve(manifestPath),
    image,
    command,
    consentProvider: consent,
  });

  console.log(`Sandbox launched successfully.`);
  console.log(`  ID:           ${sandbox.id}`);
  console.log(`  Container:    ${sandbox.containerId}`);
  console.log(`  State:        ${sandbox.state}`);
  console.log(`  Permissions:  ${sandbox.policy.scopes.length} scope(s)`);
}

function cmdSchema(): void {
  console.log(JSON.stringify(AGENT_MANIFEST_SCHEMA, null, 2));
}

function cmdPermissions(): void {
  console.log("AgentBound Permission Vocabulary:\n");
  for (const [perm, desc] of Object.entries(PERMISSION_DESCRIPTIONS)) {
    console.log(`  ${perm.padEnd(20)} ${desc}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  if (args.includes("--version")) {
    console.log("agentbound 0.1.0");
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "validate": {
      const manifestPath = args[1];
      if (!manifestPath) die("Missing manifest path. Usage: agentbound validate <manifest>");
      await cmdValidate(manifestPath);
      break;
    }

    case "generate": {
      const directory = args[1];
      if (!directory) die("Missing directory. Usage: agentbound generate <directory>");
      const nameIdx = args.indexOf("--name");
      const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
      await cmdGenerate(directory, name);
      break;
    }

    case "launch": {
      const manifestPath = args[1];
      if (!manifestPath) die("Missing manifest path.");
      const imageIdx = args.indexOf("--image");
      if (imageIdx < 0) die("Missing --image option.");
      const image = args[imageIdx + 1];
      if (!image) die("Missing image name after --image.");
      const cmdIdx = args.indexOf("--command");
      if (cmdIdx < 0) die("Missing --command option.");
      const cmd = args.slice(cmdIdx + 1);
      if (cmd.length === 0) die("Missing command after --command.");
      await cmdLaunch(manifestPath, image, cmd);
      break;
    }

    case "schema":
      cmdSchema();
      break;

    case "permissions":
      cmdPermissions();
      break;

    default:
      die(`Unknown command: ${command}. Run 'agentbound --help' for usage.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
