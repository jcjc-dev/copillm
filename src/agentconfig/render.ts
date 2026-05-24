import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import { AgentConfigError, type LoadResult } from "./load.js";
import type { McpServerEntry, ResolvedProfile } from "./schema.js";
import { getCopillmHome } from "../config/home.js";
import {
  HASH_COMMENT,
  HTML_COMMENT,
  upsertManagedBlock
} from "./markerBlock.js";

/**
 * A pending write. The apply orchestrator computes every FileWrite for every
 * agent before touching disk so a validation error never leaves the
 * filesystem half-updated.
 */
export interface FileWrite {
  path: string;
  /** Final file content to write. */
  content: string;
  mode: number;
  /** For diagnostic output only. */
  description: string;
}

export interface RenderInput {
  resolved: ResolvedProfile;
  /** cwd at the moment `copillm <agent>` was invoked. */
  cwd: string;
}

export interface CodexRenderInput extends RenderInput {
  codexHomeDir: string;
  codexBaseConfigSourcePath?: string;
}

export interface ClaudeRenderInput extends RenderInput {
  nativeSync?: boolean;
  env?: Record<string, string>;
}

export interface RenderResult {
  writes: FileWrite[];
  /** Extra env vars to set when spawning the agent. */
  envOverlay: Record<string, string>;
  /** Extra CLI args to append to the agent invocation. */
  cliArgs: string[];
  /** Human-readable lines surfaced on the launcher's stderr. */
  notes: string[];
}

// ─── Codex ────────────────────────────────────────────────────────────────

export function renderCodex(input: CodexRenderInput): RenderResult {
  const writes: FileWrite[] = [];
  const notes: string[] = [];

  const codexConfigPath = path.join(input.codexHomeDir, "config.toml");
  const existing = fs.existsSync(codexConfigPath) ? fs.readFileSync(codexConfigPath, "utf8") : "";
  let next = existing;

  if (input.codexBaseConfigSourcePath) {
    if (fs.existsSync(input.codexBaseConfigSourcePath)) {
      const source = fs.readFileSync(input.codexBaseConfigSourcePath, "utf8");
      next = mergeCodexBaseConfig(next, source, codexConfigPath, input.codexBaseConfigSourcePath);
    } else {
      notes.push(
        `Codex source config not found at ${input.codexBaseConfigSourcePath}; ` +
          `run \`copillm start\` or \`copillm codex\` once first.`
      );
    }
  }

  const mcpToml = renderCodexMcpToml(input.resolved.mcpServers);
  if (next.length === 0 && mcpToml.length > 0) {
    notes.push(
      `Codex config not found at ${codexConfigPath}; skipping MCP injection. ` +
        `Run \`copillm start\` first.`
    );
  } else {
    next = upsertManagedBlock(next, mcpToml, HASH_COMMENT);
  }
  if (next !== existing) {
    writes.push({
      path: codexConfigPath,
      content: next,
      mode: 0o600,
      description: "Codex config.toml"
    });
  }

  // 2. AGENTS.md instruction block.
  if (input.resolved.instructions) {
    const agentsPath = path.join(input.codexHomeDir, "AGENTS.md");
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
    const next = upsertManagedBlock(existing, input.resolved.instructions.body, HTML_COMMENT);
    if (next !== existing) {
      writes.push({
        path: agentsPath,
        content: next,
        mode: 0o600,
        description: "Codex AGENTS.md instructions block"
      });
    }
  }

  return { writes, envOverlay: {}, cliArgs: [], notes };
}

function mergeCodexBaseConfig(
  targetRaw: string,
  sourceRaw: string,
  targetPath: string,
  sourcePath: string
): string {
  const targetDoc = parseCodexToml(targetRaw, targetPath);
  const sourceDoc = parseCodexToml(sourceRaw, sourcePath);
  const providerId = getStringField(sourceDoc, "model_provider");

  if (!providerId) {
    throw new AgentConfigError(`Codex source config at ${sourcePath} is missing model_provider.`);
  }

  for (const key of ["model", "model_provider", "model_reasoning_effort", "approvals_reviewer"]) {
    if (key in sourceDoc) {
      targetDoc[key] = sourceDoc[key];
    }
  }

  const sourceProviders = asRecord(sourceDoc.model_providers);
  const selectedProvider = asRecord(sourceProviders?.[providerId]);
  if (!selectedProvider) {
    throw new AgentConfigError(
      `Codex source config at ${sourcePath} is missing [model_providers.${providerId}].`
    );
  }

  const targetProviders = asRecord(targetDoc.model_providers) ?? {};
  targetProviders[providerId] = selectedProvider;
  targetDoc.model_providers = targetProviders;

  return `${stringifyToml(targetDoc).trimEnd()}\n`;
}

function parseCodexToml(raw: string, filePath: string): Record<string, unknown> {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = parseToml(raw);
    return asRecord(parsed) ?? {};
  } catch (error) {
    if (error instanceof TomlError) {
      throw new AgentConfigError(`Failed to parse ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getStringField(doc: Record<string, unknown>, key: string): string | null {
  const value = doc[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function renderCodexMcpToml(servers: Record<string, McpServerEntry>): string {
  if (Object.keys(servers).length === 0) return "";
  // Build a single TOML document `{ mcp_servers: { name: {...} } }` and feed
  // smol-toml's stringify so nested maps (env, http_headers) emit valid TOML
  // inline-table syntax instead of being half-stripped by ad-hoc post-processing.
  const out: { mcp_servers: Record<string, Record<string, unknown>> } = { mcp_servers: {} };
  for (const [name, server] of Object.entries(servers)) {
    if (!isValidTomlIdent(name)) {
      throw new AgentConfigError(
        `MCP server name "${name}" is not a valid TOML identifier; ` +
          `use only letters, digits, dashes, and underscores.`
      );
    }
    if (server.transport === "stdio") {
      const entry: Record<string, unknown> = { command: server.command };
      if (server.args) entry.args = server.args;
      if (server.env) entry.env = server.env;
      if (server.cwd) entry.cwd = server.cwd;
      out.mcp_servers[name] = entry;
    } else {
      const entry: Record<string, unknown> = { url: server.url };
      if (server.headers) entry.http_headers = server.headers;
      out.mcp_servers[name] = entry;
    }
  }
  return stringifyToml(out).trimEnd();
}

const TOML_IDENT = /^[A-Za-z0-9_-]+$/;
function isValidTomlIdent(name: string): boolean {
  return TOML_IDENT.test(name);
}

// ─── Claude Code ──────────────────────────────────────────────────────────

/**
 * Launcher mode writes a copillm-owned MCP config and returns --mcp-config.
 * Native sync mode writes the user-level Claude config that Claude reads
 * without a copillm wrapper.
 */
export function renderClaude(input: ClaudeRenderInput): RenderResult {
  const writes: FileWrite[] = [];
  const notes: string[] = [];
  const cliArgs: string[] = [];

  if (input.nativeSync) {
    writes.push(...renderClaudeNativeWrites(input));
    if (input.resolved.instructions) {
      notes.push(
        "Claude: instructions fan-out is unsupported (Claude has no out-of-tree " +
          "instructions hook). Move guidance to ~/.claude/CLAUDE.md or your " +
          "project's CLAUDE.md manually."
      );
    }
    return { writes, envOverlay: {}, cliArgs, notes };
  }

  const claudeDir = path.join(getCopillmHome(), "claude");
  const mcpJsonPath = path.join(claudeDir, "mcp.json");

  const serverCount = Object.keys(input.resolved.mcpServers).length;
  if (serverCount > 0) {
    const content = renderClaudeMcp(input.resolved.mcpServers);
    const existing = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, "utf8") : null;
    if (existing !== content) {
      writes.push({
        path: mcpJsonPath,
        content,
        mode: 0o600,
        description: "Claude Code mcp.json (copillm-managed)"
      });
    }
    cliArgs.push("--mcp-config", mcpJsonPath);
  } else if (fs.existsSync(mcpJsonPath)) {
    // Profile no longer declares any servers — clear the stale file so we
    // don't keep referencing dead config on the next launch.
    fs.rmSync(mcpJsonPath, { force: true });
    notes.push(`Removed stale ${mcpJsonPath} (no MCP servers in active profile).`);
  }

  if (input.resolved.instructions) {
    notes.push(
      "Claude: instructions fan-out is unsupported (Claude has no out-of-tree " +
        "instructions hook). Move guidance to ~/.claude/CLAUDE.md or your " +
        "project's CLAUDE.md manually."
    );
  }

  return { writes, envOverlay: {}, cliArgs, notes };
}

function renderClaudeNativeWrites(input: ClaudeRenderInput): FileWrite[] {
  const writes: FileWrite[] = [];
  const userConfigPath = path.join(os.homedir(), ".claude.json");
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const manifestPath = path.join(getCopillmHome(), "claude", "native-mcp-manifest.json");

  const serverNames = Object.keys(input.resolved.mcpServers);
  const previousServerNames = readClaudeNativeManifest(manifestPath);
  if (serverNames.length > 0 || previousServerNames.length > 0) {
    const existing = readJsonObject(userConfigPath);
    const mcpServers = asRecord(existing.mcpServers) ?? {};
    for (const name of previousServerNames) {
      if (!serverNames.includes(name)) {
        delete mcpServers[name];
      }
    }
    for (const [name, server] of Object.entries(input.resolved.mcpServers)) {
      mcpServers[name] = serverToClaudeShape(server);
    }
    if (Object.keys(mcpServers).length > 0) {
      existing.mcpServers = mcpServers;
    } else {
      delete existing.mcpServers;
    }
    writes.push({
      path: userConfigPath,
      content: `${JSON.stringify(existing, null, 2)}\n`,
      mode: 0o600,
      description: "Claude Code user MCP config"
    });
    writes.push({
      path: manifestPath,
      content: `${JSON.stringify({ servers: serverNames }, null, 2)}\n`,
      mode: 0o600,
      description: "Claude Code native MCP manifest"
    });
  }

  if (input.env && Object.keys(input.env).length > 0) {
    const settings = readJsonObject(settingsPath);
    const env = asRecord(settings.env) ?? {};
    settings.env = { ...env, ...input.env };
    writes.push({
      path: settingsPath,
      content: `${JSON.stringify(settings, null, 2)}\n`,
      mode: 0o600,
      description: "Claude Code settings.json env block"
    });
  }

  return writes;
}

function readClaudeNativeManifest(filePath: string): string[] {
  const doc = readJsonObject(filePath);
  const servers = doc.servers;
  if (!Array.isArray(servers)) {
    return [];
  }
  return servers.filter((server): server is string => typeof server === "string");
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return asRecord(parsed) ?? {};
  } catch (error) {
    throw new AgentConfigError(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function renderClaudeMcp(servers: Record<string, McpServerEntry>): string {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    out[name] = serverToClaudeShape(server);
  }
  return `${JSON.stringify({ mcpServers: out }, null, 2)}\n`;
}

function serverToClaudeShape(server: McpServerEntry): Record<string, unknown> {
  if (server.transport === "stdio") {
    const out: Record<string, unknown> = {
      type: "stdio",
      command: server.command
    };
    if (server.args) out.args = server.args;
    if (server.env) out.env = server.env;
    if (server.cwd) out.cwd = server.cwd;
    return out;
  }
  const out: Record<string, unknown> = {
    type: server.transport,
    url: server.url
  };
  if (server.headers) out.headers = server.headers;
  return out;
}

// ─── pi ───────────────────────────────────────────────────────────────────

const PI_EXTENSION_DIRNAME = "copillm-mcp";

export function renderPi(input: RenderInput): RenderResult {
  const writes: FileWrite[] = [];
  const notes: string[] = [];

  const piHome = path.join(process.env.HOME ?? "", ".pi");
  const extensionDir = path.join(piHome, "agent", "extensions", PI_EXTENSION_DIRNAME);

  // 1. servers.json — the resolved server list the extension reads at startup.
  const serversJson = renderPiServersJson(input.resolved.mcpServers);
  writes.push({
    path: path.join(extensionDir, "servers.json"),
    content: serversJson,
    mode: 0o600,
    description: "pi MCP extension servers.json"
  });

  // 2. index.ts — the extension template (constant — see piExtensionTemplate.ts).
  writes.push({
    path: path.join(extensionDir, "index.ts"),
    content: PI_EXTENSION_INDEX_TS,
    mode: 0o600,
    description: "pi MCP extension index.ts"
  });

  // 3. instructions prompt registered by the extension on session_start.
  if (input.resolved.instructions) {
    const promptPath = path.join(piHome, "agent", "prompts", "copillm-profile.md");
    writes.push({
      path: promptPath,
      content: `${input.resolved.instructions.body.trim()}\n`,
      mode: 0o600,
      description: "pi profile prompt"
    });
  }

  if (Object.keys(input.resolved.mcpServers).length === 0 && !input.resolved.instructions) {
    notes.push("pi: no MCP servers or instructions in active profile; extension still written as a no-op.");
  }

  return { writes, envOverlay: {}, cliArgs: [], notes };
}

function renderPiServersJson(servers: Record<string, McpServerEntry>): string {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    out[name] = serverToClaudeShape(server); // same wire shape works
  }
  return `${JSON.stringify({ servers: out }, null, 2)}\n`;
}

// Template for the pi extension. Kept inline (small) so a single commit ships
// both the renderer and the runtime side-by-side. The extension is
// deliberately conservative: it logs what it sees and registers a placeholder
// tool per server. Wiring real MCP stdio/http transport is left for a follow-up
// PR — this lands the plumbing without claiming working tool-calls.
const PI_EXTENSION_INDEX_TS = `// Generated by copillm. Do not edit by hand.
// Source of truth: ~/.copillm/agent.toml
//
// This extension is registered automatically by copillm whenever you run
// \`copillm pi\`. It loads the resolved MCP server list from the sibling
// servers.json and exposes each entry to pi. v1 only registers the servers
// and surfaces them via a slash command; real MCP transport wiring lands in
// a follow-up.

import fs from "node:fs";
import path from "node:path";

interface PiApi {
  registerCommand: (name: string, handler: () => Promise<string> | string) => void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
}

export default function activate(pi: PiApi): void {
  const serversPath = path.join(__dirname, "servers.json");
  let servers: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(serversPath, "utf8")) as { servers?: Record<string, unknown> };
    servers = raw.servers ?? {};
  } catch {
    servers = {};
  }

  pi.registerCommand("copillm-mcp", () => {
    const names = Object.keys(servers);
    if (names.length === 0) return "No MCP servers configured via copillm.";
    return "copillm-managed MCP servers:\\n" + names.map((n) => "  - " + n).join("\\n");
  });

  const promptPath = path.join(process.env.HOME ?? "", ".pi", "agent", "prompts", "copillm-profile.md");
  if (fs.existsSync(promptPath) && typeof pi.on === "function") {
    pi.on("session_start", () => {
      try {
        const body = fs.readFileSync(promptPath, "utf8");
        // pi swallows return values from event handlers; logging the body
        // suffices for the v1 plumbing — instruction injection lands in v2.
        console.log("[copillm] loaded profile prompt (" + body.length + " bytes)");
      } catch {
        /* swallow */
      }
    });
  }
}
`;

// ─── Copilot CLI (stub) ───────────────────────────────────────────────────

export function renderCopilot(_input: RenderInput): RenderResult {
  return {
    writes: [],
    envOverlay: {},
    cliArgs: [],
    notes: [
      "Copilot CLI: native MCP config format is not yet documented publicly. " +
        "Skipping fan-out. Track upstream and remove this stub when the path is known."
    ]
  };
}

// ─── Apply orchestrator ──────────────────────────────────────────────────

export type AgentKind = "codex" | "claude" | "pi" | "copilot";

export interface ApplyOptions {
  agent: AgentKind;
  cwd: string;
  profileOverride?: string | null;
  skip?: boolean;
  /** Required when agent === "codex". */
  codexHomeDir?: string;
  codexBaseConfigSourcePath?: string;
  claudeNativeSync?: boolean;
  claudeEnv?: Record<string, string>;
}

export interface ApplyResult {
  active: string | null;
  writes: FileWrite[];
  envOverlay: Record<string, string>;
  cliArgs: string[];
  notes: string[];
  sources: LoadResult["sources"];
}

export function planRender(opts: ApplyOptions, load: LoadResult): RenderResult {
  const baseInput: RenderInput = { resolved: load.resolved, cwd: opts.cwd };
  switch (opts.agent) {
    case "codex": {
      if (!opts.codexHomeDir) {
        throw new AgentConfigError("renderCodex requires codexHomeDir");
      }
      return renderCodex({
        ...baseInput,
        codexHomeDir: opts.codexHomeDir,
        codexBaseConfigSourcePath: opts.codexBaseConfigSourcePath
      });
    }
    case "claude":
      return renderClaude({
        ...baseInput,
        nativeSync: opts.claudeNativeSync,
        env: opts.claudeEnv
      });
    case "pi":
      return renderPi(baseInput);
    case "copilot":
      return renderCopilot(baseInput);
  }
}
