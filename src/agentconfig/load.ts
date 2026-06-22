import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";
import { ZodError } from "zod";
import { getCopillmHome } from "../config/home.js";
import {
  AgentTomlSchema,
  type AgentToml,
  type McpServerEntry,
  type ResolvedProfile,
  type Section,
  type YoloConfig
} from "./schema.js";

export interface LoadOptions {
  cwd: string;
  profileOverride?: string | null;
}

export interface LoadResult {
  /** Name of the profile that ended up active. */
  active: string;
  /** Fully merged + env-expanded view ready to feed renderers. */
  resolved: ResolvedProfile;
  /** Files that contributed to the resolved tree (for `copillm config show`). */
  sources: { path: string; scope: "global" | "project" }[];
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

/**
 * Returns null when no agent.toml exists anywhere. Callers should treat this
 * as a clean no-op and skip fan-out entirely.
 */
export function loadAgentConfig(options: LoadOptions): LoadResult | null {
  const globalPath = path.join(getCopillmHome(), "agent.toml");
  const projectPath = path.join(options.cwd, ".copillm", "agent.toml");

  const globalDoc = readDocument(globalPath, "global");
  const projectDoc = readDocument(projectPath, "project");

  if (!globalDoc && !projectDoc) {
    return null;
  }

  const active =
    options.profileOverride ??
    projectDoc?.parsed.active_profile ??
    globalDoc?.parsed.active_profile ??
    "default";

  const resolved = mergeAndResolve({ globalDoc, projectDoc, profileName: active });

  const sources: LoadResult["sources"] = [];
  if (globalDoc) sources.push({ path: globalDoc.filePath, scope: "global" });
  if (projectDoc) sources.push({ path: projectDoc.filePath, scope: "project" });

  return { active, resolved, sources };
}

interface LoadedDocument {
  filePath: string;
  scope: "global" | "project";
  parsed: AgentToml;
}

function readDocument(filePath: string, scope: "global" | "project"): LoadedDocument | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (error) {
    if (error instanceof TomlError) {
      const where = `line ${error.line} col ${error.column}`;
      throw new AgentConfigError(
        `Failed to parse ${filePath}: ${error.message} (at ${where}). ` +
          `TOML duplicate keys and syntax errors are not auto-corrected — fix the file and re-run.`
      );
    }
    throw error;
  }
  let validated: AgentToml;
  try {
    validated = AgentTomlSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((issue) => `  • ${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("\n");
      throw new AgentConfigError(
        `${filePath} does not match the expected schema:\n${issues}`
      );
    }
    throw error;
  }
  return { filePath, scope, parsed: validated };
}

function mergeAndResolve(input: {
  globalDoc: LoadedDocument | null;
  projectDoc: LoadedDocument | null;
  profileName: string;
}): ResolvedProfile {
  // Each layer carries the scope of the document it came from so the env
  // expansion step can refuse `${VAR}` substitution for project-scope
  // entries. The point of the refusal is to keep an attacker who controls a
  // project's `.copillm/agent.toml` from harvesting the user's ambient secrets
  // (GITHUB_TOKEN, AWS_*, NPM_TOKEN, OPENAI_API_KEY, …) into an MCP server's
  // url/headers/command and exfiltrating them to a remote endpoint on next
  // agent launch.
  const layers: ScopedSection[] = [];
  if (input.globalDoc?.parsed.defaults) layers.push({ section: input.globalDoc.parsed.defaults, scope: "global" });
  if (input.globalDoc?.parsed.profiles?.[input.profileName]) {
    layers.push({ section: input.globalDoc.parsed.profiles[input.profileName], scope: "global" });
  }
  if (input.projectDoc?.parsed.defaults) layers.push({ section: input.projectDoc.parsed.defaults, scope: "project" });
  if (input.projectDoc?.parsed.profiles?.[input.profileName]) {
    layers.push({ section: input.projectDoc.parsed.profiles[input.profileName], scope: "project" });
  }

  if (layers.length === 0) {
    const where: string[] = [];
    if (input.globalDoc) where.push(input.globalDoc.filePath);
    if (input.projectDoc) where.push(input.projectDoc.filePath);
    throw new AgentConfigError(
      `No profile "${input.profileName}" found in ${where.join(" or ")}. ` +
        `Add [profiles.${input.profileName}] or set active_profile.`
    );
  }

  // Merge instructions: later layers overwrite (typically the project tail).
  let instructionsBody: string | null = null;
  for (const { section } of layers) {
    if (section.instructions?.body !== undefined) {
      instructionsBody = section.instructions.body;
    }
  }
  const instructions =
    instructionsBody !== null && instructionsBody.trim().length > 0
      ? { body: instructionsBody }
      : null;

  // Merge the pinned account: later layers (project over global, profile over
  // defaults) win. Empty string is treated as unset.
  let account: string | null = null;
  for (const { section } of layers) {
    if (section.account !== undefined && section.account.trim().length > 0) {
      account = section.account.trim();
    }
  }

  // Merge mcp.servers map; later layers replace earlier same-named entries.
  // Defaults are always-on: a profile may override a default by name but
  // cannot remove it. Each entry is expanded under the scope of its source
  // layer — project-scope entries are NOT permitted to interpolate
  // `${VAR}` from process.env.
  const servers: Record<string, McpServerEntry> = {};
  for (const { section, scope } of layers) {
    const layerServers = section.mcp?.servers ?? {};
    for (const [name, value] of Object.entries(layerServers)) {
      servers[name] = expandEnv(value, scope, name);
    }
  }

  const sections = layers.map((l) => l.section);
  const reserved = {
    skills: mergeRecord(sections, "skills"),
    agents: mergeRecord(sections, "agents"),
    hooks: mergeRecord(sections, "hooks"),
    permissions: mergeRecord(sections, "permissions")
  };

  const yolo = mergeYolo(sections);

  return { instructions, mcpServers: servers, account, yolo, reserved };
}

interface ScopedSection {
  section: Section;
  scope: "global" | "project";
}

/**
 * Layer yolo blocks across defaults + active profile. Later layers (project
 * over global, profile over defaults) override earlier ones at the field
 * level: `enabled` is replaced wholesale, `agents.<id>` is merged per-key so
 * a profile can toggle a single agent without clearing the rest.
 *
 * Returns null when no layer declared `[...yolo]`, so callers can distinguish
 * "config has no opinion" from "config explicitly said false".
 */
function mergeYolo(layers: Section[]): YoloConfig | null {
  let saw = false;
  let enabled: boolean | undefined;
  const agents: NonNullable<YoloConfig["agents"]> = {};
  for (const layer of layers) {
    const y = layer.yolo;
    if (!y) continue;
    saw = true;
    if (y.enabled !== undefined) enabled = y.enabled;
    if (y.agents) Object.assign(agents, y.agents);
  }
  if (!saw) return null;
  const out: YoloConfig = {};
  if (enabled !== undefined) out.enabled = enabled;
  if (Object.keys(agents).length > 0) out.agents = agents;
  return out;
}

function mergeRecord(layers: Section[], key: keyof Section): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    const sub = layer[key] as Record<string, unknown> | undefined;
    if (sub) Object.assign(out, sub);
  }
  return out;
}

/** Expand `${VAR}` and `${VAR:-default}` in url/command/args/env/headers.
 *
 * Only the global `~/.copillm/agent.toml` is allowed to interpolate
 * `process.env`. A project-scope `.copillm/agent.toml` that tries to expand a
 * variable is rejected — an attacker who lands a malicious project file in a
 * cloned repo would otherwise be able to capture the user's ambient secrets
 * into a remote MCP url, header, or command on the next agent launch.
 */
function expandEnv(entry: McpServerEntry, scope: "global" | "project", serverName: string): McpServerEntry {
  const expand = (value: string, field: string): string => expandString(value, scope, serverName, field);
  if (entry.transport === "stdio") {
    return {
      ...entry,
      command: expand(entry.command, "command"),
      args: entry.args?.map((a, i) => expand(a, `args[${i}]`)),
      env: entry.env ? expandRecord(entry.env, scope, serverName, "env") : undefined
    };
  }
  return {
    ...entry,
    url: expand(entry.url, "url"),
    headers: entry.headers ? expandRecord(entry.headers, scope, serverName, "headers") : undefined
  };
}

function expandRecord(
  rec: Record<string, string>,
  scope: "global" | "project",
  serverName: string,
  field: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = expandString(v, scope, serverName, `${field}.${k}`);
  }
  return out;
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand `${VAR}` / `${VAR:-default}` in a single string value. When called
 * with no scope (legacy callers, tests, the exported helper), behaves as
 * before. When called with `scope = "project"`, refuses to expand at all and
 * throws — the project-scope refusal is a deliberate trust gate, not an opt-in.
 */
export function expandString(
  value: string,
  scope?: "global" | "project",
  serverName?: string,
  field?: string
): string {
  if (scope === "project" && ENV_PATTERN.test(value)) {
    // Reset the regex's lastIndex (it has /g, and the .test() above advanced it).
    ENV_PATTERN.lastIndex = 0;
    const location =
      serverName !== undefined && field !== undefined
        ? `mcp.servers.${serverName}.${field}`
        : "an mcp server entry";
    throw new AgentConfigError(
      `Refusing to expand \${...} in ${location} of a project-scope agent.toml. ` +
        `Project-scope env substitution would let a cloned repo's config harvest ambient secrets ` +
        `(GITHUB_TOKEN, AWS_*, etc.) on the next agent launch. Move this entry to ~/.copillm/agent.toml ` +
        `if you trust the value, or inline the literal value here.`
    );
  }
  // Reset lastIndex so .replace() starts from the beginning.
  ENV_PATTERN.lastIndex = 0;
  return value.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
    const fromEnv = process.env[name];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    if (fallback !== undefined) return fallback;
    throw new AgentConfigError(
      `Required env var "${name}" is not set and no default was provided in the agent.toml expansion.`
    );
  });
}
