import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function debugLogPath(): string {
  return path.join(getCopillmHome(), "debug.log");
}

/**
 * The directory pi (`@earendil-works/pi-coding-agent`) reads its config from.
 *
 * pi exposes this via the `PI_CODING_AGENT_DIR` env var — its own `getAgentDir()`
 * treats the value as the agent dir directly (equivalent to `~/.pi/agent`).
 * copillm owns this path: it defaults to `<COPILLM_HOME>/pi/agent` so copillm
 * never writes into the user's real `~/.pi`, and dev mode relocates it for free
 * via COPILLM_HOME. An explicitly-set `PI_CODING_AGENT_DIR` always wins.
 */
export function piAgentDir(): string {
  const overridden = process.env.PI_CODING_AGENT_DIR;
  if (overridden && overridden.trim().length > 0) {
    return path.resolve(overridden.trim());
  }
  return path.join(getCopillmHome(), "pi", "agent");
}

/**
 * The config home Claude Code reads (its `~/.claude` equivalent), exposed by
 * Claude Code as the `CLAUDE_CONFIG_DIR` env var.
 *
 * copillm owns this path: it defaults to `<COPILLM_HOME>/claude/home` and copillm
 * exports `CLAUDE_CONFIG_DIR` to it when launching Claude (see
 * `buildClaudeEnvBundle`). This keeps copillm out of the user's real `~/.claude`
 * — copillm-launched Claude gets a deterministic, copillm-owned config home, and
 * dev mode relocates it for free via COPILLM_HOME. An explicitly-set
 * `CLAUDE_CONFIG_DIR` always wins.
 */
export function claudeConfigDir(): string {
  const overridden = process.env.CLAUDE_CONFIG_DIR;
  if (overridden && overridden.trim().length > 0) {
    return path.resolve(overridden.trim());
  }
  return path.join(getCopillmHome(), "claude", "home");
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
