import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectClaudeSettingsConflicts,
  formatSettingsConflictWarning
} from "../../../src/integrations/claude/settingsConflict.js";

const tmpDirs: string[] = [];

function makeSettingsFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "copillm-claude-settings-"));
  tmpDirs.push(dir);
  const settingsPath = path.join(dir, "settings.json");
  writeFileSync(settingsPath, contents, "utf8");
  return settingsPath;
}

function makeSettingsDir(): string {
  // Returns a path that IS a directory rather than a file, so fs.readFileSync
  // returns a non-ENOENT error (EISDIR / EBADF depending on platform). Used to
  // exercise the parseError branch portably on macOS/Linux/Windows without
  // relying on chmod tricks that vary by OS and CI runner permissions.
  const dir = mkdtempSync(path.join(tmpdir(), "copillm-claude-settings-dir-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const launcherEnv = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:4141/anthropic",
  ANTHROPIC_AUTH_TOKEN: "copillm-local"
};

describe("detectClaudeSettingsConflicts", () => {
  it("returns no conflicts when settings file does not exist", () => {
    const missingPath = path.join(tmpdir(), `copillm-missing-${Date.now()}.json`);
    const result = detectClaudeSettingsConflicts(launcherEnv, missingPath);
    expect(result.exists).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(result.parseError).toBeNull();
  });

  it("returns no conflicts when settings.json has no env block", () => {
    const settingsPath = makeSettingsFile(JSON.stringify({ model: "opus" }));
    const result = detectClaudeSettingsConflicts(launcherEnv, settingsPath);
    expect(result.exists).toBe(true);
    expect(result.parseError).toBeNull();
    expect(result.conflicts).toEqual([]);
  });

  it("flags keys whose settings value differs from launcher value", () => {
    const settingsPath = makeSettingsFile(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:5000",
          ANTHROPIC_AUTH_TOKEN: "stale-token",
          UNRELATED: "keep me"
        }
      })
    );
    const result = detectClaudeSettingsConflicts(launcherEnv, settingsPath);
    expect(result.exists).toBe(true);
    expect(result.parseError).toBeNull();
    expect(result.conflicts).toEqual([
      {
        key: "ANTHROPIC_BASE_URL",
        settingsValue: "http://localhost:5000",
        launcherValue: "http://127.0.0.1:4141/anthropic"
      },
      {
        key: "ANTHROPIC_AUTH_TOKEN",
        settingsValue: "stale-token",
        launcherValue: "copillm-local"
      }
    ]);
  });

  it("ignores keys whose settings value matches launcher value", () => {
    const settingsPath = makeSettingsFile(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:4141/anthropic",
          ANTHROPIC_AUTH_TOKEN: "copillm-local"
        }
      })
    );
    const result = detectClaudeSettingsConflicts(launcherEnv, settingsPath);
    expect(result.conflicts).toEqual([]);
  });

  it("ignores keys not present in launcher env", () => {
    const settingsPath = makeSettingsFile(
      JSON.stringify({
        env: {
          SOMETHING_ELSE: "value"
        }
      })
    );
    const result = detectClaudeSettingsConflicts(launcherEnv, settingsPath);
    expect(result.conflicts).toEqual([]);
  });

  it("reports parse errors without crashing", () => {
    const settingsPath = makeSettingsFile("{not json");
    const result = detectClaudeSettingsConflicts(launcherEnv, settingsPath);
    expect(result.exists).toBe(true);
    expect(result.parseError).not.toBeNull();
    expect(result.conflicts).toEqual([]);
  });

  it("reports read errors (non-ENOENT) so the user is warned", () => {
    // Point at a directory rather than a file → readFileSync raises EISDIR/EBADF
    // (not ENOENT), which previously would set parseError silently.
    const settingsPath = makeSettingsDir();
    const result = detectClaudeSettingsConflicts(launcherEnv, settingsPath);
    expect(result.exists).toBe(true);
    expect(result.parseError).not.toBeNull();
    expect(result.conflicts).toEqual([]);
  });

  it("ignores non-string env values", () => {
    const settingsPath = makeSettingsFile(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 12345,
          ANTHROPIC_AUTH_TOKEN: null
        }
      })
    );
    const result = detectClaudeSettingsConflicts(launcherEnv, settingsPath);
    expect(result.conflicts).toEqual([]);
  });
});

describe("formatSettingsConflictWarning", () => {
  it("returns empty array when there are no conflicts", () => {
    expect(
      formatSettingsConflictWarning({
        settingsPath: "/fake",
        exists: true,
        parseError: null,
        conflicts: []
      })
    ).toEqual([]);
  });

  it("produces a clear, actionable warning naming each key and value", () => {
    const lines = formatSettingsConflictWarning({
      settingsPath: "/home/user/.claude/settings.json",
      exists: true,
      parseError: null,
      conflicts: [
        {
          key: "ANTHROPIC_BASE_URL",
          settingsValue: "http://localhost:5000",
          launcherValue: "http://127.0.0.1:4141/anthropic"
        }
      ]
    });
    const joined = lines.join("\n");
    expect(joined).toContain("settings.json overrides copillm");
    expect(joined).toContain("/home/user/.claude/settings.json");
    expect(joined).toContain("ANTHROPIC_BASE_URL");
    expect(joined).toContain("http://localhost:5000");
    expect(joined).toContain("http://127.0.0.1:4141/anthropic");
    expect(joined).toContain("remove these keys");
  });

  it("warns the user when settings.json could not be read or parsed", () => {
    // The whole point of this PR is to surface silent env overrides; if we
    // can't determine whether they exist, the user needs to be told that the
    // detector ran but couldn't conclude — not silently return no warning.
    const lines = formatSettingsConflictWarning({
      settingsPath: "/home/user/.claude/settings.json",
      exists: true,
      parseError: "EACCES: permission denied, open '/home/user/.claude/settings.json'",
      conflicts: []
    });
    const joined = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(joined).toContain("could not inspect");
    expect(joined).toContain("/home/user/.claude/settings.json");
    expect(joined).toContain("EACCES");
    expect(joined).toContain("ANTHROPIC_BASE_URL");
  });

  it("prioritises the read/parse-error warning over any populated conflicts", () => {
    // parseError and a non-empty conflicts list shouldn't co-occur in practice
    // (the detector clears conflicts when parseError is set), but the formatter
    // should still degrade safely: surface the reason it couldn't trust the
    // file rather than emit potentially-stale conflict details.
    const lines = formatSettingsConflictWarning({
      settingsPath: "/fake",
      exists: true,
      parseError: "boom",
      conflicts: [
        { key: "ANTHROPIC_BASE_URL", settingsValue: "stale", launcherValue: "fresh" }
      ]
    });
    const joined = lines.join("\n");
    expect(joined).toContain("could not inspect");
    expect(joined).not.toContain("Fix: remove these keys");
  });
});
