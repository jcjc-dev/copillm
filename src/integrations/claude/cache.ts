import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeCacheClearResult {
  cleared: boolean;
  path: string;
  reason: null | string;
}

export function claudeGatewayCachePath(): string {
  return path.join(os.homedir(), ".claude", "cache", "gateway-models.json");
}

export function clearClaudeGatewayCache(): ClaudeCacheClearResult {
  const target = claudeGatewayCachePath();
  if (!fs.existsSync(target)) {
    return { cleared: false, path: target, reason: "not_present" };
  }
  try {
    fs.unlinkSync(target);
    return { cleared: true, path: target, reason: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown_error";
    return { cleared: false, path: target, reason: detail };
  }
}
