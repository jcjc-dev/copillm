import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import { AgentConfigError, type LoadResult } from "./load.js";
import type {
  ExternalProviderConfig,
  McpServerEntry,
  ResolvedProfile,
  YoloConfig
} from "./schema.js";
import {
  claudeMcpConfigPath,
  copilotHomeDir,
  getCopillmHome,
  piAgentDir,
  assertSafeProfileName,
  type AgentSessionScope
} from "../config/home.js";
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
  /** Active profile name used to namespace isolated agent state. */
  profileName?: string;
  /** Resolved shared/isolated state policy. */
  sessionScope?: AgentSessionScope;
}

export interface CodexRenderInput extends RenderInput {
  codexHomeDir: string;
  codexBaseConfigSourcePath?: string;
}

export interface ClaudeRenderInput extends RenderInput {
  nativeSync?: boolean;
  env?: Record<string, string>;
}

type ProviderTarget =
  | ExternalProviderConfig["pi"]
  | ExternalProviderConfig["codex"]
  | ExternalProviderConfig["copilot"];

interface EffectiveProviderTarget {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
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

function resolveProviderTarget(
  provider: ExternalProviderConfig,
  target: ProviderTarget
): EffectiveProviderTarget {
  return {
    baseUrl: target.base_url ?? provider.base_url,
    model: target.model ?? provider.model,
    apiKeyEnv: target.api_key_env ?? provider.api_key_env
  };
}

function assertProviderCapability(
  provider: ExternalProviderConfig,
  capability: "chat_completions" | "responses",
  agent: string
): void {
  const supported =
    capability === "responses" ? provider.supports_responses : provider.supports_chat_completions;
  if (!supported) {
    const endpoint = capability === "responses" ? "OpenAI Responses" : "OpenAI Chat Completions";
    throw new AgentConfigError(
      `External provider "${provider.id}" cannot be used with ${agent}: ` +
        `supports_${capability} is false, but ${endpoint} is required.`
    );
  }
}

function requireProviderApiKey(
  provider: ExternalProviderConfig,
  target: EffectiveProviderTarget,
  agent: string
): string | null {
  if (!target.apiKeyEnv) {
    return null;
  }
  const value = process.env[target.apiKeyEnv];
  if (value === undefined || value.length === 0) {
    throw new AgentConfigError(
      `External provider "${provider.id}" for ${agent} requires environment variable "${target.apiKeyEnv}".`
    );
  }
  return value;
}

// ─── Codex ────────────────────────────────────────────────────────────────

export function renderCodex(input: CodexRenderInput): RenderResult {
  const writes: FileWrite[] = [];
  const notes: string[] = [];

  const codexConfigPath = path.join(input.codexHomeDir, "config.toml");
  const existing = fs.existsSync(codexConfigPath) ? fs.readFileSync(codexConfigPath, "utf8") : "";
  let next = input.resolved.provider
    ? renderExternalCodexConfig(existing, input.resolved.provider)
    : existing;

  if (!input.resolved.provider && input.codexBaseConfigSourcePath) {
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
  if (input.resolved.provider) {
    notes.push(`using external provider "${input.resolved.provider.id}" for Codex`);
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

function renderExternalCodexConfig(
  existingRaw: string,
  provider: ExternalProviderConfig
): string {
  assertProviderCapability(provider, "responses", "Codex");
  const target = resolveProviderTarget(provider, provider.codex);
  requireProviderApiKey(provider, target, "Codex");

  const doc = parseCodexToml(existingRaw, "Codex config.toml");
  const providers = asRecord(doc.model_providers) ?? {};
  const providerDoc: Record<string, unknown> = {
    name: provider.name ?? provider.id,
    base_url: target.baseUrl,
    wire_api: "responses",
    requires_openai_auth: false
  };
  if (target.apiKeyEnv) {
    providerDoc.env_key = target.apiKeyEnv;
  }
  if (provider.codex.query_params) {
    providerDoc.query_params = provider.codex.query_params;
  }
  if (provider.codex.request_max_retries !== undefined) {
    providerDoc.request_max_retries = provider.codex.request_max_retries;
  }
  if (provider.codex.stream_max_retries !== undefined) {
    providerDoc.stream_max_retries = provider.codex.stream_max_retries;
  }
  if (provider.codex.stream_idle_timeout_ms !== undefined) {
    providerDoc.stream_idle_timeout_ms = provider.codex.stream_idle_timeout_ms;
  }

  providers[provider.id] = providerDoc;
  doc.model = target.model;
  doc.model_provider = provider.id;
  if (provider.codex.reasoning_effort !== undefined) {
    doc.model_reasoning_effort = provider.codex.reasoning_effort;
  }
  doc.model_providers = providers;
  return `${stringifyToml(doc).trimEnd()}\n`;
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

  const mcpJsonPath = claudeMcpConfigPath(input.sessionScope, input.profileName);

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
  const homeDir = userHomeDir();
  const userConfigPath = path.join(homeDir, ".claude.json");
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
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

function userHomeDir(): string {
  return process.env.HOME ?? os.homedir();
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

  const piAgent = piAgentDir(input.sessionScope, input.profileName);
  const extensionDir = path.join(piAgent, "extensions", PI_EXTENSION_DIRNAME);

  if (input.resolved.provider) {
    const modelsPath = path.join(piAgent, "models.json");
    const existing = fs.existsSync(modelsPath) ? fs.readFileSync(modelsPath, "utf8") : "";
    const content = renderExternalPiModels(input.resolved.provider);
    if (existing !== content) {
      writes.push({
        path: modelsPath,
        content,
        mode: 0o600,
        description: "pi models.json (external provider)"
      });
    }
    const mirrorPath = externalPiMirrorPath(input.sessionScope, input.profileName);
    const mirrorExisting = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, "utf8") : "";
    if (mirrorPath !== modelsPath && mirrorExisting !== content) {
      writes.push({
        path: mirrorPath,
        content,
        mode: 0o600,
        description: "pi models.json mirror (external provider)"
      });
    }
    notes.push(`using external provider "${input.resolved.provider.id}" for pi`);
  }

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
    const promptPath = path.join(piAgent, "prompts", "copillm-profile.md");
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

function externalPiMirrorPath(
  sessionScope: AgentSessionScope | undefined,
  profileName: string | undefined
): string {
  if (sessionScope === "isolated") {
    assertSafeProfileName(profileName);
    return path.join(getCopillmHome(), "profiles", profileName, "pi", "models.json");
  }
  return path.join(getCopillmHome(), "pi", "models.json");
}

function renderExternalPiModels(provider: ExternalProviderConfig): string {
  const target = resolveProviderTarget(provider, provider.pi);
  const requiredCapability =
    provider.pi.api === "openai-responses" ? "responses" : "chat_completions";
  assertProviderCapability(provider, requiredCapability, "pi");
  requireProviderApiKey(provider, target, "pi");

  const model: Record<string, unknown> = {
    id: target.model
  };
  if (provider.name) {
    model.name = provider.name;
  }
  if (provider.context_window !== undefined) {
    model.contextWindow = provider.context_window;
  }
  if (provider.max_output_tokens !== undefined) {
    model.maxTokens = provider.max_output_tokens;
  }
  if (provider.reasoning) {
    model.reasoning = true;
  }
  if (provider.input) {
    model.input = provider.input;
  }

  const piProvider: Record<string, unknown> = {
    baseUrl: target.baseUrl,
    api: provider.pi.api,
    // pi requires a non-empty apiKey field for custom providers. When the
    // endpoint is keyless this is an inert placeholder that local servers
    // ignore; no real secret is persisted in models.json.
    apiKey:
      target.apiKeyEnv
        ? `$${target.apiKeyEnv}`
        : "copillm-local",
    models: [model]
  };
  if (provider.pi.auth_header) {
    piProvider.authHeader = true;
  }
  const compat = renderPiCompat(provider.pi.compat);
  if (Object.keys(compat).length > 0) {
    piProvider.compat = compat;
  }

  return `${JSON.stringify({ providers: { [provider.id]: piProvider } }, null, 2)}\n`;
}

function renderPiCompat(
  compat: ExternalProviderConfig["pi"]["compat"]
): Record<string, unknown> {
  if (!compat) {
    return {};
  }
  const out: Record<string, unknown> = {};
  if (compat.max_tokens_field !== undefined) {
    out.maxTokensField = compat.max_tokens_field;
  }
  if (compat.thinking_format !== undefined) {
    out.thinkingFormat = compat.thinking_format;
  }
  if (compat.supports_developer_role !== undefined) {
    out.supportsDeveloperRole = compat.supports_developer_role;
  }
  if (compat.supports_reasoning_effort !== undefined) {
    out.supportsReasoningEffort = compat.supports_reasoning_effort;
  }
  if (compat.supports_usage_in_streaming !== undefined) {
    out.supportsUsageInStreaming = compat.supports_usage_in_streaming;
  }
  if (compat.requires_tool_result_name !== undefined) {
    out.requiresToolResultName = compat.requires_tool_result_name;
  }
  if (compat.requires_reasoning_content_on_assistant_messages !== undefined) {
    out.requiresReasoningContentOnAssistantMessages =
      compat.requires_reasoning_content_on_assistant_messages;
  }
  if (compat.reasoning_effort_map !== undefined) {
    out.reasoningEffortMap = compat.reasoning_effort_map;
  }
  if (compat.thinking_level_map !== undefined) {
    out.thinkingLevelMap = compat.thinking_level_map;
  }
  return out;
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

  // Resolve the prompt relative to this extension's own directory. copillm
  // owns the pi agent dir (via PI_CODING_AGENT_DIR), and the extension lives at
  // <agentDir>/extensions/<name>/, so the prompt is two levels up under prompts/.
  const promptPath = path.join(__dirname, "..", "..", "prompts", "copillm-profile.md");
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

// ─── Copilot CLI ──────────────────────────────────────────────────────────

export function renderCopilot(input: RenderInput): RenderResult {
  const writes: FileWrite[] = [];
  const notes: string[] = [];
  const cliArgs: string[] = [];
  const envOverlay: Record<string, string> = {};

  if (input.resolved.provider) {
    const provider = input.resolved.provider;
    const target = resolveProviderTarget(provider, provider.copilot);
    if (provider.type !== "anthropic") {
      assertProviderCapability(provider, "chat_completions", "Copilot CLI");
    }
    if (!provider.tool_calling || !provider.streaming) {
      throw new AgentConfigError(
        `External provider "${provider.id}" cannot be used with Copilot CLI: ` +
          "tool_calling and streaming must both be true."
      );
    }
    const apiKey = requireProviderApiKey(provider, target, "Copilot CLI");
    envOverlay.COPILOT_PROVIDER_BASE_URL = target.baseUrl;
    envOverlay.COPILOT_PROVIDER_TYPE = provider.type;
    envOverlay.COPILOT_MODEL = target.model;
    if (apiKey !== null) {
      envOverlay.COPILOT_PROVIDER_API_KEY = apiKey;
    }
    envOverlay.COPILOT_OFFLINE = provider.copilot.offline ? "true" : "false";
    notes.push(`using external provider "${provider.id}" for Copilot CLI`);
  }

  const mcpConfigPath = path.join(
    copilotHomeDir(input.sessionScope, input.profileName),
    "mcp-config.json"
  );
  const serverCount = Object.keys(input.resolved.mcpServers).length;
  if (serverCount > 0) {
    const content = renderCopilotMcp(input.resolved.mcpServers);
    const existing = fs.existsSync(mcpConfigPath) ? fs.readFileSync(mcpConfigPath, "utf8") : null;
    if (existing !== content) {
      writes.push({
        path: mcpConfigPath,
        content,
        mode: 0o600,
        description: "Copilot CLI MCP config (copillm-managed)"
      });
    }
    cliArgs.push("--additional-mcp-config", `@${mcpConfigPath}`);
  } else if (fs.existsSync(mcpConfigPath)) {
    fs.rmSync(mcpConfigPath, { force: true });
    notes.push(`Removed stale ${mcpConfigPath} (no MCP servers in active profile).`);
  }

  return {
    writes,
    envOverlay,
    cliArgs,
    notes
  };
}

function renderCopilotMcp(servers: Record<string, McpServerEntry>): string {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === "stdio") {
      const entry: Record<string, unknown> = {
        type: "local",
        command: server.command,
        tools: ["*"]
      };
      if (server.args) entry.args = server.args;
      if (server.env) entry.env = server.env;
      if (server.cwd) entry.cwd = server.cwd;
      out[name] = entry;
    } else {
      const entry: Record<string, unknown> = {
        type: server.transport,
        url: server.url,
        tools: ["*"]
      };
      if (server.headers) entry.headers = server.headers;
      out[name] = entry;
    }
  }
  return `${JSON.stringify({ mcpServers: out }, null, 2)}\n`;
}

// ─── Apply orchestrator ──────────────────────────────────────────────────

export type AgentKind = "codex" | "claude" | "pi" | "copilot";

export interface ApplyOptions {
  agent: AgentKind;
  cwd: string;
  profileOverride?: string | null;
  skip?: boolean;
  /** Optional pre-loaded profile, so launchers can decide routing once. */
  loaded?: LoadResult | null;
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
  /** Merged yolo block from the resolved profile, or null if no config. */
  yolo: YoloConfig | null;
}

export function planRender(opts: ApplyOptions, load: LoadResult): RenderResult {
  const baseInput: RenderInput = {
    resolved: load.resolved,
    cwd: opts.cwd,
    profileName: load.active,
    sessionScope: load.resolved.sessionScope
  };
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
