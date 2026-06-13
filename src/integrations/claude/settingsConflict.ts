import fs from "node:fs";
import { claudeConfigDir } from "../../config/home.js";
import path from "node:path";

export interface SettingsEnvConflict {
  key: string;
  settingsValue: string;
  launcherValue: string;
}

export interface DetectSettingsConflictsResult {
  settingsPath: string;
  exists: boolean;
  parseError: null | string;
  conflicts: SettingsEnvConflict[];
}

export function claudeSettingsPath(): string {
  // copillm-launched Claude reads settings from its copillm-owned config home
  // (CLAUDE_CONFIG_DIR), so the conflict check inspects that file — not the
  // user's real ~/.claude/settings.json.
  return path.join(claudeConfigDir(), "settings.json");
}

export function detectClaudeSettingsConflicts(
  launcherEnv: Record<string, string>,
  settingsPathOverride?: string
): DetectSettingsConflictsResult {
  const settingsPath = settingsPathOverride ?? claudeSettingsPath();
  const empty = { settingsPath, exists: false, parseError: null, conflicts: [] as SettingsEnvConflict[] };

  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return empty;
    }
    return { ...empty, exists: true, parseError: errMessage(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { settingsPath, exists: true, parseError: errMessage(error), conflicts: [] };
  }

  const env = readEnvBlock(parsed);
  if (!env) {
    return { settingsPath, exists: true, parseError: null, conflicts: [] };
  }

  const conflicts: SettingsEnvConflict[] = [];
  for (const [key, launcherValue] of Object.entries(launcherEnv)) {
    const settingsValue = env[key];
    if (typeof settingsValue !== "string") continue;
    if (settingsValue === launcherValue) continue;
    conflicts.push({ key, settingsValue, launcherValue });
  }

  return { settingsPath, exists: true, parseError: null, conflicts };
}

export function formatSettingsConflictWarning(result: DetectSettingsConflictsResult): string[] {
  if (result.parseError !== null) {
    return [
      "",
      "⚠ copillm could not inspect Claude Code's settings.json for env overrides.",
      `  File: ${result.settingsPath}`,
      `  Reason: ${result.parseError}`,
      "  If the file exists and sets `env` keys like ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN,",
      "  Claude Code will silently override copillm's values once launched. Inspect the file",
      "  manually (or fix the read/parse error above) so this check can run.",
      ""
    ];
  }
  if (result.conflicts.length === 0) return [];
  const lines: string[] = [];
  lines.push("");
  lines.push("⚠ Claude Code settings.json overrides copillm's env vars.");
  lines.push(`  File: ${result.settingsPath}`);
  lines.push("  Claude Code exports its settings.json `env` block into its own process environment,");
  lines.push("  which takes precedence over values supplied by `copillm claude` or your shell.");
  lines.push("  The following keys will silently override copillm's values:");
  for (const conflict of result.conflicts) {
    lines.push(`    • ${conflict.key}`);
    lines.push(`        settings.json: ${conflict.settingsValue}`);
    lines.push(`        copillm value: ${conflict.launcherValue}`);
  }
  lines.push("  Fix: remove these keys from the `env` block in the file above, then re-run.");
  lines.push("");
  return lines;
}

function readEnvBlock(parsed: unknown): null | Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") return null;
  const env = (parsed as { env?: unknown }).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  return env as Record<string, unknown>;
}

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
