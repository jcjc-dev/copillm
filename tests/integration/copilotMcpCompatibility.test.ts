import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentConfig } from "../../src/agentconfig/apply.js";

let tmpHome: string;
let tmpCwd: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedCopillmHome: string | undefined;

const realCopilot = findRealCopilot();
const maybeDescribe = realCopilot ? describe : describe.skip;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-real-copilot-mcp-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-real-copilot-mcp-cwd-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedCopillmHome = process.env.COPILLM_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.COPILLM_HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedUserProfile;
  if (savedCopillmHome === undefined) delete process.env.COPILLM_HOME;
  else process.env.COPILLM_HOME = savedCopillmHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

maybeDescribe("Copilot CLI MCP compatibility", () => {
  it("writes MCP config that the real Copilot CLI can read", () => {
    fs.writeFileSync(
      path.join(tmpHome, "agent.toml"),
      `
[defaults.mcp.servers.echo_reader]
transport = "stdio"
command = "echo"
args = ["hello"]
env = { READER_TEST = "1" }
cwd = "/tmp"

[profiles.work.mcp.servers.remote_reader]
transport = "http"
url = "https://example.com/mcp"
headers = { X_Test = "ok" }
`
    );

    applyAgentConfig({ agent: "copilot", cwd: tmpCwd, profileOverride: "work" });
    const managedPath = path.join(tmpHome, "copilot", "mcp-config.json");
    const nativePath = path.join(tmpHome, ".copilot", "mcp-config.json");
    fs.mkdirSync(path.dirname(nativePath), { recursive: true });
    fs.copyFileSync(managedPath, nativePath);

    const result = spawnSync(realCopilot!, ["mcp", "list", "--json"], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        NO_COLOR: "1"
      },
      encoding: "utf8",
      timeout: 30_000,
      shell: process.platform === "win32"
    });

    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcpServers.echo_reader).toMatchObject({
      type: "local",
      command: "echo",
      args: ["hello"],
      cwd: "/tmp",
      env: { READER_TEST: "1" },
      source: "user"
    });
    expect(parsed.mcpServers.remote_reader).toMatchObject({
      type: "http",
      url: "https://example.com/mcp",
      headers: { X_Test: "ok" },
      source: "user"
    });
  });
});

function findRealCopilot(): string | null {
  const configured = process.env.COPILLM_REAL_COPILOT_BIN;
  if (configured) {
    return canRunCopilot(configured) ? configured : null;
  }
  return canRunCopilot("copilot") ? "copilot" : null;
}

function canRunCopilot(bin: string): boolean {
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    shell: process.platform === "win32"
  });
  return result.status === 0;
}
