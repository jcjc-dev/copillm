import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentStateRoot,
  claudeConfigDir,
  claudeMcpConfigPath,
  codexHomeDir,
  copilotHomeDir,
  listIsolatedProfileRoots,
  piAgentDir
} from "../../../src/config/home.js";

const ENV_KEYS = [
  "COPILLM_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "COPILOT_HOME"
] as const;

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-agent-state-"));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.COPILLM_HOME = tmpHome;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("agent state paths", () => {
  it("preserves the existing shared paths", () => {
    expect(agentStateRoot("shared", "personal")).toBe(tmpHome);
    expect(claudeConfigDir("shared", "personal")).toBe(path.join(tmpHome, "claude", "home"));
    expect(claudeMcpConfigPath("shared", "personal")).toBe(path.join(tmpHome, "claude", "mcp.json"));
    expect(codexHomeDir("shared", "personal")).toBe(path.join(tmpHome, "codex"));
    expect(piAgentDir("shared", "personal")).toBe(path.join(tmpHome, "pi", "agent"));
    expect(copilotHomeDir("shared", "personal")).toBe(path.join(tmpHome, "copilot"));
  });

  it("namespaces every supported agent under the active profile when isolated", () => {
    const root = path.join(tmpHome, "profiles", "personal");
    expect(agentStateRoot("isolated", "personal")).toBe(root);
    expect(claudeConfigDir("isolated", "personal")).toBe(path.join(root, "claude", "home"));
    expect(claudeMcpConfigPath("isolated", "personal")).toBe(path.join(root, "claude", "mcp.json"));
    expect(codexHomeDir("isolated", "personal")).toBe(path.join(root, "codex"));
    expect(piAgentDir("isolated", "personal")).toBe(path.join(root, "pi", "agent"));
    expect(copilotHomeDir("isolated", "personal")).toBe(path.join(root, "copilot"));
  });

  it("rejects unsafe profile names before constructing an isolated path", () => {
    for (const profile of ["", ".", "..", "../escape", "a/b", "a\\b", "name with spaces"]) {
      expect(() => agentStateRoot("isolated", profile)).toThrow(/profile names/i);
    }
  });

  it("lets explicit agent home environment variables override profile isolation", () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "custom-claude");
    process.env.CODEX_HOME = path.join(tmpHome, "custom-codex");
    process.env.PI_CODING_AGENT_DIR = path.join(tmpHome, "custom-pi");
    process.env.COPILOT_HOME = path.join(tmpHome, "custom-copilot");

    expect(claudeConfigDir("isolated", "personal")).toBe(path.join(tmpHome, "custom-claude"));
    expect(codexHomeDir("isolated", "personal")).toBe(path.join(tmpHome, "custom-codex"));
    expect(piAgentDir("isolated", "personal")).toBe(path.join(tmpHome, "custom-pi"));
    expect(copilotHomeDir("isolated", "personal")).toBe(path.join(tmpHome, "custom-copilot"));
  });

  it("lists only safe profile roots for cleanup", () => {
    fs.mkdirSync(path.join(tmpHome, "profiles", "personal"), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, "profiles", "work"), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, "profiles", "bad name"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, "profiles", "not-a-dir"), "ignored");

    expect(listIsolatedProfileRoots().sort()).toEqual([
      path.join(tmpHome, "profiles", "personal"),
      path.join(tmpHome, "profiles", "work")
    ]);
  });
});
