import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir } from "../../config/home.js";

export interface ClaudeCacheClearResult {
  cleared: boolean;
  path: string;
  reason: null | string;
}

export function claudeGatewayCachePath(): string {
  // Claude stores the gateway model-picker cache under its config home
  // (CLAUDE_CONFIG_DIR). copillm owns that home, so we clear the copillm-owned
  // copy — never the user's real ~/.claude.
  return path.join(claudeConfigDir(), "cache", "gateway-models.json");
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
