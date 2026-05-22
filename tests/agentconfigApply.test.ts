import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentConfig } from "../src/agentconfig/apply.js";
import { AgentConfigError } from "../src/agentconfig/load.js";

let tmpHome: string;
let tmpCwd: string;
let savedHome: string | undefined;
let savedCopillmHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-apply-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-apply-cwd-"));
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

describe("applyAgentConfig — claude", () => {
  it("preserves user-owned entries and tags copillm ones via _copillmManaged", () => {
    writeGlobal(`
[defaults.mcp.servers.copillm-github]
transport = "http"
url = "https://example.com/mcp"
[profiles.default]
`);
    // Pre-existing user-owned .mcp.json.
    fs.writeFileSync(
      path.join(tmpCwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { "user-owned": { type: "stdio", command: "true" } } })
    );

    const result = applyAgentConfig({ agent: "claude", cwd: tmpCwd });
    expect(result.writes.length).toBeGreaterThan(0);
    const written = JSON.parse(fs.readFileSync(path.join(tmpCwd, ".mcp.json"), "utf8"));
    expect(written.mcpServers["user-owned"]).toEqual({ type: "stdio", command: "true" });
    expect(written.mcpServers["copillm-github"]).toBeDefined();
    expect(written._copillmManaged).toEqual(["copillm-github"]);
  });

  it("removes stale copillm entries on re-run", () => {
    writeGlobal(`
[defaults.mcp.servers.first]
transport = "http"
url = "https://example.com/a"
[profiles.default]
`);
    applyAgentConfig({ agent: "claude", cwd: tmpCwd });

    // Rewrite profile with a different server.
    writeGlobal(`
[defaults.mcp.servers.second]
transport = "http"
url = "https://example.com/b"
[profiles.default]
`);
    applyAgentConfig({ agent: "claude", cwd: tmpCwd });

    const written = JSON.parse(fs.readFileSync(path.join(tmpCwd, ".mcp.json"), "utf8"));
    expect(written.mcpServers.first).toBeUndefined();
    expect(written.mcpServers.second).toBeDefined();
    expect(written._copillmManaged).toEqual(["second"]);
  });

  it("aborts on user-owned vs copillm name collision", () => {
    writeGlobal(`
[defaults.mcp.servers.shared]
transport = "http"
url = "https://example.com/mcp"
[profiles.default]
`);
    fs.writeFileSync(
      path.join(tmpCwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { type: "stdio", command: "true" } } })
    );
    expect(() => applyAgentConfig({ agent: "claude", cwd: tmpCwd })).toThrow(AgentConfigError);
    expect(() => applyAgentConfig({ agent: "claude", cwd: tmpCwd })).toThrow(/already exists/);
  });

  it("wraps instructions in marker block in CLAUDE.md", () => {
    writeGlobal(`
[defaults.instructions]
body = "Be terse."
[profiles.default]
`);
    fs.writeFileSync(path.join(tmpCwd, "CLAUDE.md"), "# Project rules\n\nuse npm test\n");
    applyAgentConfig({ agent: "claude", cwd: tmpCwd });
    const md = fs.readFileSync(path.join(tmpCwd, "CLAUDE.md"), "utf8");
    expect(md).toContain("# Project rules");
    expect(md).toContain("use npm test");
    expect(md).toContain("copillm:managed begin");
    expect(md).toContain("Be terse.");
    expect(md).toContain("copillm:managed end");

    // Second run with new body replaces in place, not duplicates.
    writeGlobal(`
[defaults.instructions]
body = "Be very terse."
[profiles.default]
`);
    applyAgentConfig({ agent: "claude", cwd: tmpCwd });
    const md2 = fs.readFileSync(path.join(tmpCwd, "CLAUDE.md"), "utf8");
    expect(md2.match(/copillm:managed begin/g)?.length).toBe(1);
    expect(md2).toContain("Be very terse.");
    expect(md2).not.toContain("Be terse.\n"); // old body gone
  });
});

describe("applyAgentConfig — pi", () => {
  it("writes the extension dir with servers.json and index.ts", () => {
    writeGlobal(`
[defaults.mcp.servers.echo]
transport = "stdio"
command = "echo"
args = ["hi"]
[profiles.default]
`);
    applyAgentConfig({ agent: "pi", cwd: tmpCwd });
    const extDir = path.join(tmpHome, ".pi", "agent", "extensions", "copillm-mcp");
    expect(fs.existsSync(path.join(extDir, "index.ts"))).toBe(true);
    const servers = JSON.parse(fs.readFileSync(path.join(extDir, "servers.json"), "utf8"));
    expect(servers.servers.echo.command).toBe("echo");
  });
});

describe("applyAgentConfig — skip + no-config", () => {
  it("returns no-op when no agent.toml exists", () => {
    const result = applyAgentConfig({ agent: "claude", cwd: tmpCwd });
    expect(result.active).toBeNull();
    expect(result.writes).toEqual([]);
  });

  it("returns no-op when skip=true even if agent.toml exists", () => {
    writeGlobal(`
[defaults.mcp.servers.x]
transport = "http"
url = "https://example.com"
[profiles.default]
`);
    const result = applyAgentConfig({ agent: "claude", cwd: tmpCwd, skip: true });
    expect(result.active).toBeNull();
  });
});
