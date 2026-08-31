import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeConfigDir } from "../../../src/config/home.js";
import { clearClaudeGatewayCache, claudeGatewayCachePath } from "../../../src/integrations/claude/cache.js";
import { claudeSettingsPath } from "../../../src/integrations/claude/settingsConflict.js";

// copillm owns Claude's config home so it never reads/writes the user's real
// ~/.claude. The gateway-cache and settings-conflict paths must follow it.
const ENV_KEYS = ["COPILLM_HOME", "CLAUDE_CONFIG_DIR"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("Claude config home (copillm-owned)", () => {
  it("defaults to <COPILLM_HOME>/claude/home and never the real ~/.claude", () => {
    const copillmHome = path.join(os.tmpdir(), "copillm-claude-home-test");
    process.env.COPILLM_HOME = copillmHome;

    const expectedDir = path.join(copillmHome, "claude", "home");
    expect(claudeConfigDir()).toBe(expectedDir);
    expect(claudeGatewayCachePath()).toBe(path.join(expectedDir, "cache", "gateway-models.json"));
    expect(claudeSettingsPath()).toBe(path.join(expectedDir, "settings.json"));

    const realClaude = path.join(os.homedir(), ".claude");
    expect(claudeGatewayCachePath().startsWith(realClaude)).toBe(false);
    expect(claudeSettingsPath().startsWith(realClaude)).toBe(false);
  });

  it("honors an explicit CLAUDE_CONFIG_DIR (user override wins)", () => {
    const custom = path.join(os.tmpdir(), "custom-claude-cfg");
    process.env.CLAUDE_CONFIG_DIR = custom;

    expect(claudeConfigDir()).toBe(path.resolve(custom));
    expect(claudeGatewayCachePath()).toBe(path.join(path.resolve(custom), "cache", "gateway-models.json"));
    expect(claudeSettingsPath()).toBe(path.join(path.resolve(custom), "settings.json"));
  });

  it("clears shared and isolated profile gateway caches", () => {
    const copillmHome = path.join(os.tmpdir(), "copillm-claude-cache-test");
    process.env.COPILLM_HOME = copillmHome;
    const shared = claudeGatewayCachePath();
    const isolated = claudeGatewayCachePath("isolated", "personal");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.mkdirSync(path.dirname(isolated), { recursive: true });
    fs.writeFileSync(shared, "{}");
    fs.writeFileSync(isolated, "{}");

    try {
      const result = clearClaudeGatewayCache();
      expect(result.cleared).toBe(true);
      expect(result.clearedPaths.sort()).toEqual([shared, isolated].sort());
      expect(fs.existsSync(shared)).toBe(false);
      expect(fs.existsSync(isolated)).toBe(false);
    } finally {
      fs.rmSync(copillmHome, { recursive: true, force: true });
    }
  });
});
