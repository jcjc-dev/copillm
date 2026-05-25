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
