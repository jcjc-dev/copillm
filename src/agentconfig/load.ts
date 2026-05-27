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
  const layers: Section[] = [];
  if (input.globalDoc?.parsed.defaults) layers.push(input.globalDoc.parsed.defaults);
  if (input.globalDoc?.parsed.profiles?.[input.profileName]) {
    layers.push(input.globalDoc.parsed.profiles[input.profileName]);
  }
  if (input.projectDoc?.parsed.defaults) layers.push(input.projectDoc.parsed.defaults);
  if (input.projectDoc?.parsed.profiles?.[input.profileName]) {
    layers.push(input.projectDoc.parsed.profiles[input.profileName]);
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
  for (const layer of layers) {
    if (layer.instructions?.body !== undefined) {
      instructionsBody = layer.instructions.body;
    }
  }
  const instructions =
    instructionsBody !== null && instructionsBody.trim().length > 0
      ? { body: instructionsBody }
      : null;

  // Merge mcp.servers map; later layers replace earlier same-named entries.
  // Defaults are always-on: a profile may override a default by name but
  // cannot remove it.
  const servers: Record<string, McpServerEntry> = {};
  for (const layer of layers) {
    const layerServers = layer.mcp?.servers ?? {};
    for (const [name, value] of Object.entries(layerServers)) {
      servers[name] = expandEnv(value);
    }
  }

  const reserved = {
    skills: mergeRecord(layers, "skills"),
    agents: mergeRecord(layers, "agents"),
    hooks: mergeRecord(layers, "hooks"),
    permissions: mergeRecord(layers, "permissions")
  };

  const yolo = mergeYolo(layers);

  return { instructions, mcpServers: servers, yolo, reserved };
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

/** Expand `${VAR}` and `${VAR:-default}` in url/command/args/env/headers. */
function expandEnv(entry: McpServerEntry): McpServerEntry {
  const expand = (value: string): string => expandString(value);
  if (entry.transport === "stdio") {
    return {
      ...entry,
      command: expand(entry.command),
      args: entry.args?.map(expand),
      env: entry.env ? expandRecord(entry.env) : undefined
    };
  }
  return {
    ...entry,
    url: expand(entry.url),
    headers: entry.headers ? expandRecord(entry.headers) : undefined
  };
}

function expandRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandString(v);
  return out;
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function expandString(value: string): string {
  return value.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
    const fromEnv = process.env[name];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    if (fallback !== undefined) return fallback;
    throw new AgentConfigError(
      `Required env var "${name}" is not set and no default was provided in the agent.toml expansion.`
    );
  });
}
