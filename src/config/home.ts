import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentSessionScope = "shared" | "isolated";

export function getCopillmHome(): string {
  const overridden = process.env.COPILLM_HOME;
  if (overridden && overridden.trim().length > 0) {
    return path.resolve(overridden.trim());
  }
  return path.join(os.homedir(), ".copillm");
}

export function configPath(): string {
  return path.join(getCopillmHome(), "config.yaml");
}

export function configReadPath(): string {
  return resolveReadablePath("config.yaml");
}

export function credentialsPath(): string {
  return path.join(getCopillmHome(), "credentials.json");
}

export function credentialsReadPath(): string {
  return resolveReadablePath("credentials.json");
}

/**
 * Path to the multi-account index (`accounts.json`). Metadata only — never
 * holds a token. Absent on single-account installs, which keep using the
 * legacy `credentials.json` / keychain entry as the implicit default account.
 */
export function accountsIndexPath(): string {
  return path.join(getCopillmHome(), "accounts.json");
}

export function accountsIndexReadPath(): string {
  return resolveReadablePath("accounts.json");
}

/**
 * Plaintext-fallback credential file for a *named* (non-default) account. The
 * default account keeps the legacy `credentials.json` path for backward
 * compatibility; additional accounts are namespaced by id so their tokens
 * never collide with — or overwrite — the pre-existing default.
 */
export function accountCredentialsPath(accountId: string): string {
  return path.join(getCopillmHome(), `credentials.${accountId}.json`);
}

export function accountCredentialsReadPath(accountId: string): string {
  return resolveReadablePath(`credentials.${accountId}.json`);
}

export function lockPath(): string {
  return path.join(getCopillmHome(), "copillm.pid");
}

export function lockReadPath(): string {
  return resolveReadablePath("copillm.pid");
}

export function modelsCachePath(): string {
  return path.join(getCopillmHome(), "models.cache.json");
}

export function modelsCacheReadPath(): string {
  return resolveReadablePath("models.cache.json");
}

/**
 * Per-account model-discovery cache. Different accounts can be entitled to
 * different model catalogs, so each named account caches into its own
 * `models.cache.<id>.json`. The primary/legacy account keeps the shared
 * `models.cache.json` (above), so single-account installs are unaffected.
 */
export function accountModelsCachePath(accountId: string): string {
  return path.join(getCopillmHome(), `models.cache.${accountId}.json`);
}

export function accountModelsCacheReadPath(accountId: string): string {
  return resolveReadablePath(`models.cache.${accountId}.json`);
}

export function debugLogPath(): string {
  return path.join(getCopillmHome(), "debug.log");
}

/**
 * The root used for downstream agent state.
 *
 * `shared` deliberately returns the historical copillm home so existing
 * profiles keep using the same files. `isolated` namespaces state by the
 * resolved profile name while leaving copillm's daemon, credentials, binary
 * cache, and model caches in the shared home.
 */
export function agentStateRoot(scope: AgentSessionScope = "shared", profileName?: string | null): string {
  if (scope === "shared") {
    return getCopillmHome();
  }
  assertSafeProfileName(profileName);
  return path.join(getCopillmHome(), "profiles", profileName);
}

export function assertSafeProfileName(profileName: string | null | undefined): asserts profileName is string {
  if (
    typeof profileName !== "string" ||
    profileName.length === 0 ||
    profileName === "." ||
    profileName === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(profileName)
  ) {
    throw new Error(
      `Cannot use isolated session scope for profile "${String(profileName)}": ` +
        "profile names must contain only letters, digits, '.', '_' or '-'."
    );
  }
}

/** Return the roots of all profile-namespaced agent state directories. */
export function listIsolatedProfileRoots(): string[] {
  const profilesRoot = path.join(getCopillmHome(), "profiles");
  if (!fs.existsSync(profilesRoot)) {
    return [];
  }
  try {
    return fs
      .readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeProfileName(entry.name))
      .map((entry) => path.join(profilesRoot, entry.name));
  } catch {
    return [];
  }
}

function isSafeProfileName(profileName: string): boolean {
  return (
    profileName.length > 0 &&
    profileName !== "." &&
    profileName !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(profileName)
  );
}

export function codexHomeDir(scope: AgentSessionScope = "shared", profileName?: string | null): string {
  const overridden = process.env.CODEX_HOME;
  if (overridden && overridden.trim().length > 0) {
    return path.resolve(overridden.trim());
  }
  return path.join(agentStateRoot(scope, profileName), "codex");
}

/**
 * The directory pi (`@earendil-works/pi-coding-agent`) reads its config from.
 *
 * pi exposes this via the `PI_CODING_AGENT_DIR` env var — its own `getAgentDir()`
 * treats the value as the agent dir directly (equivalent to `~/.pi/agent`).
 * copillm owns this path: it defaults to `<COPILLM_HOME>/pi/agent` in shared
 * mode and `<COPILLM_HOME>/profiles/<profile>/pi/agent` in isolated mode, so
 * copillm never writes into the user's real `~/.pi`. An explicitly-set
 * `PI_CODING_AGENT_DIR` always wins.
 */
export function piAgentDir(scope: AgentSessionScope = "shared", profileName?: string | null): string {
  const overridden = process.env.PI_CODING_AGENT_DIR;
  if (overridden && overridden.trim().length > 0) {
    return path.resolve(overridden.trim());
  }
  return path.join(agentStateRoot(scope, profileName), "pi", "agent");
}

/**
 * The config home Claude Code reads (its `~/.claude` equivalent), exposed by
 * Claude Code as the `CLAUDE_CONFIG_DIR` env var.
 *
 * copillm owns this path: it defaults to `<COPILLM_HOME>/claude/home` in shared
 * mode and `<COPILLM_HOME>/profiles/<profile>/claude/home` in isolated mode.
 * This keeps copillm out of the user's real `~/.claude`; an explicitly-set
 * `CLAUDE_CONFIG_DIR` always wins.
 */
export function claudeConfigDir(scope: AgentSessionScope = "shared", profileName?: string | null): string {
  const overridden = process.env.CLAUDE_CONFIG_DIR;
  if (overridden && overridden.trim().length > 0) {
    return path.resolve(overridden.trim());
  }
  return path.join(agentStateRoot(scope, profileName), "claude", "home");
}

export function claudeMcpConfigPath(scope: AgentSessionScope = "shared", profileName?: string | null): string {
  return path.join(agentStateRoot(scope, profileName), "claude", "mcp.json");
}

/**
 * Copilot CLI's own home is intentionally untouched in shared mode. The
 * launcher only exports COPILOT_HOME for an isolated profile, but renderers
 * still use an explicitly supplied COPILOT_HOME when one exists.
 */
export function copilotHomeDir(scope: AgentSessionScope = "shared", profileName?: string | null): string {
  const overridden = process.env.COPILOT_HOME;
  if (overridden && overridden.trim().length > 0) {
    return path.resolve(overridden.trim());
  }
  return path.join(agentStateRoot(scope, profileName), "copilot");
}

function resolveReadablePath(fileName: string): string {
  const canonical = path.join(getCopillmHome(), fileName);
  if (fs.existsSync(canonical)) {
    return canonical;
  }
  if (!process.env.COPILLM_HOME) {
    const legacy = legacyHome();
    if (legacy) {
      const fallback = path.join(legacy, fileName);
      if (fs.existsSync(fallback)) {
        return fallback;
      }
    }
  }
  return canonical;
}

function legacyHome(): null | string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "copillm");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData && appData.trim().length > 0) {
      return path.join(appData, "copillm");
    }
  }
  return null;
}
