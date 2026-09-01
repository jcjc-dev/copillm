import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir, listIsolatedProfileRoots } from "../../config/home.js";

export interface ClaudeCacheClearResult {
  cleared: boolean;
  path: string;
  clearedPaths: string[];
  reason: null | string;
}

export function claudeGatewayCachePath(
  scope: "shared" | "isolated" = "shared",
  profileName?: string | null
): string {
  // Claude stores the gateway model-picker cache under its config home
  // (CLAUDE_CONFIG_DIR). copillm owns that home, so we clear the copillm-owned
  // copy — never the user's real ~/.claude.
  return path.join(claudeConfigDir(scope, profileName), "cache", "gateway-models.json");
}

export function clearClaudeGatewayCache(): ClaudeCacheClearResult {
  const targets = [
    claudeGatewayCachePath(),
    ...listIsolatedProfileRoots().map((root) =>
      path.join(root, "claude", "home", "cache", "gateway-models.json")
    )
  ];
  const clearedPaths: string[] = [];
  const failures: string[] = [];

  for (const target of targets) {
    if (!fs.existsSync(target)) {
      continue;
    }
    try {
      fs.unlinkSync(target);
      clearedPaths.push(target);
    } catch (error) {
      failures.push(`${target}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return {
    cleared: clearedPaths.length > 0,
    path: targets[0],
    clearedPaths,
    reason:
      failures.length > 0
        ? failures.join("; ")
        : clearedPaths.length === 0
          ? "not_present"
          : null
  };
}
