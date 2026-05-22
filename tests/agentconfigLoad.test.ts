import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigError, expandString, loadAgentConfig } from "../src/agentconfig/load.js";

let tmpHome: string;
let tmpCwd: string;
let savedHome: string | undefined;
let savedCopillmHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-agentconfig-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-agentconfig-cwd-"));
  savedHome = process.env.HOME;
  savedCopillmHome = process.env.COPILLM_HOME;
  process.env.HOME = tmpHome;
  process.env.COPILLM_HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = savedHome;
  if (savedCopillmHome === undefined) delete process.env.COPILLM_HOME;
  else process.env.COPILLM_HOME = savedCopillmHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function writeGlobal(content: string): void {
  fs.writeFileSync(path.join(tmpHome, "agent.toml"), content);
}

function writeProject(content: string): void {
  fs.mkdirSync(path.join(tmpCwd, ".copillm"), { recursive: true });
  fs.writeFileSync(path.join(tmpCwd, ".copillm", "agent.toml"), content);
}

describe("loadAgentConfig", () => {
  it("returns null when neither file exists", () => {
    expect(loadAgentConfig({ cwd: tmpCwd })).toBeNull();
  });

  it("loads a global default profile", () => {
    writeGlobal(`
active_profile = "default"
[defaults.mcp.servers.github]
transport = "http"
url = "https://example.com/mcp"
[profiles.default]
`);
    const result = loadAgentConfig({ cwd: tmpCwd });
    expect(result?.active).toBe("default");
    expect(Object.keys(result?.resolved.mcpServers ?? {})).toEqual(["github"]);
  });

  it("project overlay replaces same-named server", () => {
    writeGlobal(`
[defaults.mcp.servers.db]
transport = "stdio"
command = "global-cmd"
[profiles.default]
`);
    writeProject(`
[defaults.mcp.servers.db]
transport = "stdio"
command = "project-cmd"
`);
    const result = loadAgentConfig({ cwd: tmpCwd });
    const db = result?.resolved.mcpServers.db;
    expect(db?.transport).toBe("stdio");
    expect(db && db.transport === "stdio" ? db.command : null).toBe("project-cmd");
  });

  it("@unset removes inherited server", () => {
    writeGlobal(`
[defaults.mcp.servers.db]
transport = "stdio"
command = "default-cmd"

[profiles.minimal.mcp.servers.db]
inherit = "@unset"
`);
    const result = loadAgentConfig({ cwd: tmpCwd, profileOverride: "minimal" });
    expect(result?.resolved.mcpServers.db).toBeUndefined();
  });

  it("rejects duplicate TOML keys with parser diagnostic", () => {
    writeGlobal(`
[defaults.mcp.servers.x]
transport = "http"
url = "https://a"
[defaults.mcp.servers.x]
transport = "http"
url = "https://b"
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(/parse/i);
  });

  it("rejects unknown top-level keys", () => {
    writeGlobal(`
nonsense_key = 1
[profiles.default]
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(AgentConfigError);
  });

  it("rejects http server without url", () => {
    writeGlobal(`
[defaults.mcp.servers.bad]
transport = "http"
[profiles.default]
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(AgentConfigError);
  });

  it("falls back to default profile name when active_profile is omitted", () => {
    writeGlobal(`
[profiles.default.mcp.servers.x]
transport = "http"
url = "https://x"
`);
    const result = loadAgentConfig({ cwd: tmpCwd });
    expect(result?.active).toBe("default");
    expect(result?.resolved.mcpServers.x).toBeDefined();
  });

  it("errors when the active profile doesn't exist", () => {
    writeGlobal(`
active_profile = "missing"
[profiles.default]
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(/profile "missing"/);
  });

  it("captures instructions from the deepest layer", () => {
    writeGlobal(`
[defaults.instructions]
body = "global"
[profiles.default.instructions]
body = "profile"
`);
    writeProject(`
[profiles.default.instructions]
body = "project"
`);
    expect(loadAgentConfig({ cwd: tmpCwd })?.resolved.instructions?.body).toBe("project");
  });
});

describe("expandString", () => {
  it("substitutes env vars", () => {
    process.env._CC_TEST_VAR = "value";
    expect(expandString("a-${_CC_TEST_VAR}-b")).toBe("a-value-b");
    delete process.env._CC_TEST_VAR;
  });

  it("applies fallback when var missing", () => {
    expect(expandString("${_NOT_SET:-fallback}")).toBe("fallback");
  });

  it("throws when required var is missing", () => {
    delete process.env._STRICT_NOT_SET;
    expect(() => expandString("${_STRICT_NOT_SET}")).toThrow(AgentConfigError);
  });
});
