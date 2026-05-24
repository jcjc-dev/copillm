import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentConfig } from "../src/agentconfig/apply.js";

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
  it("writes mcp.json under ~/.copillm/claude and emits --mcp-config CLI args", () => {
    writeGlobal(`
[defaults.mcp.servers.copillm-github]
transport = "http"
url = "https://example.com/mcp"
[profiles.default]
`);
    // Pre-existing cwd .mcp.json — copillm must NOT touch it.
    const cwdMcp = path.join(tmpCwd, ".mcp.json");
    fs.writeFileSync(
      cwdMcp,
      JSON.stringify({ mcpServers: { "user-owned": { type: "stdio", command: "true" } } })
    );
    const cwdMcpBefore = fs.readFileSync(cwdMcp, "utf8");

    const result = applyAgentConfig({ agent: "claude", cwd: tmpCwd });
    expect(result.writes.length).toBeGreaterThan(0);

    // cwd file is untouched.
    expect(fs.readFileSync(cwdMcp, "utf8")).toBe(cwdMcpBefore);

    // Managed file lives under ~/.copillm/claude/mcp.json.
    const managedPath = path.join(tmpHome, "claude", "mcp.json");
    expect(fs.existsSync(managedPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(managedPath, "utf8"));
    expect(written.mcpServers["copillm-github"]).toBeDefined();
    expect(written.mcpServers["user-owned"]).toBeUndefined(); // never merged
    expect(written._copillmManaged).toBeUndefined(); // no marker needed in isolated file

    // Launcher must add --mcp-config <managedPath>.
    expect(result.cliArgs).toEqual(["--mcp-config", managedPath]);
  });

  it("replaces stale servers on re-run (no merge with prior managed file)", () => {
    writeGlobal(`
[defaults.mcp.servers.first]
transport = "http"
url = "https://example.com/a"
[profiles.default]
`);
    applyAgentConfig({ agent: "claude", cwd: tmpCwd });

    writeGlobal(`
[defaults.mcp.servers.second]
transport = "http"
url = "https://example.com/b"
[profiles.default]
`);
    applyAgentConfig({ agent: "claude", cwd: tmpCwd });

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpHome, "claude", "mcp.json"), "utf8")
    );
    expect(written.mcpServers.first).toBeUndefined();
    expect(written.mcpServers.second).toBeDefined();
  });

  it("removes managed file when profile no longer declares any servers", () => {
    writeGlobal(`
[defaults.mcp.servers.first]
transport = "http"
url = "https://example.com/a"
[profiles.default]
`);
    applyAgentConfig({ agent: "claude", cwd: tmpCwd });
    const managedPath = path.join(tmpHome, "claude", "mcp.json");
    expect(fs.existsSync(managedPath)).toBe(true);

    writeGlobal(`[profiles.default]\n`);
    const result = applyAgentConfig({ agent: "claude", cwd: tmpCwd });
    expect(fs.existsSync(managedPath)).toBe(false);
    expect(result.cliArgs).toEqual([]);
  });

  it("never writes CLAUDE.md to cwd, even when instructions are set", () => {
    writeGlobal(`
[defaults.instructions]
body = "Be terse."
[profiles.default]
`);
    applyAgentConfig({ agent: "claude", cwd: tmpCwd });
    expect(fs.existsSync(path.join(tmpCwd, "CLAUDE.md"))).toBe(false);
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
