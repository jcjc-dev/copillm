import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { applyAgentConfig } from "../../../src/agentconfig/apply.js";

let tmpHome: string;
let tmpCwd: string;
let savedHome: string | undefined;
let savedCopillmHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-codex-render-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-codex-render-cwd-"));
  savedHome = process.env.HOME;
  savedCopillmHome = process.env.COPILLM_HOME;
  process.env.HOME = tmpHome;
  process.env.COPILLM_HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, "codex"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, "codex", "config.toml"),
    [
      'model = "claude-sonnet-4.6"',
      'model_provider = "copillm"',
      "",
      "[model_providers.copillm]",
      'name = "copillm"',
      'base_url = "http://127.0.0.1:5050/codex/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      ""
    ].join("\n")
  );
});

afterEach(() => {
  process.env.HOME = savedHome;
  if (savedCopillmHome === undefined) delete process.env.COPILLM_HOME;
  else process.env.COPILLM_HOME = savedCopillmHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("codex renderer", () => {
  it("produces a config.toml that round-trips through a TOML parser", () => {
    fs.writeFileSync(
      path.join(tmpHome, "agent.toml"),
      `
[defaults.mcp.servers.echo]
transport = "stdio"
command = "echo"
args = ["hi", "there"]
env = { LOG_LEVEL = "info", FOO = "bar" }

[defaults.mcp.servers.remote-api]
transport = "http"
url = "https://example.com/mcp"
headers = { Authorization = "Bearer abc", X-Trace = "1" }

[profiles.default]
`
    );
    applyAgentConfig({
      agent: "codex",
      cwd: tmpCwd,
      codexHomeDir: path.join(tmpHome, "codex")
    });

    const written = fs.readFileSync(path.join(tmpHome, "codex", "config.toml"), "utf8");

    // 1. Marker block present.
    expect(written).toContain("# copillm:managed begin");
    expect(written).toContain("# copillm:managed end");

    // 2. Original Codex provider block preserved.
    expect(written).toContain('model = "claude-sonnet-4.6"');
    expect(written).toContain("[model_providers.copillm]");

    // 3. The full file parses as valid TOML — this is the guard the previous
    //    iteration of the renderer broke (nested env/headers tables got mangled).
    const parsed = parseToml(written) as {
      mcp_servers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers).toBeDefined();
    expect(parsed.mcp_servers?.echo.command).toBe("echo");
    expect(parsed.mcp_servers?.echo.args).toEqual(["hi", "there"]);
    expect(parsed.mcp_servers?.echo.env).toEqual({ LOG_LEVEL: "info", FOO: "bar" });
    expect(parsed.mcp_servers?.["remote-api"].url).toBe("https://example.com/mcp");
    expect(parsed.mcp_servers?.["remote-api"].http_headers).toEqual({
      Authorization: "Bearer abc",
      "X-Trace": "1"
    });
  });

  it("can merge the copillm provider into the native Codex config", () => {
    fs.writeFileSync(
      path.join(tmpHome, "agent.toml"),
      `
[defaults.mcp.servers.echo]
transport = "stdio"
command = "echo"

[profiles.default]
`
    );

    const nativeCodexHome = path.join(tmpHome, ".codex");
    fs.mkdirSync(nativeCodexHome, { recursive: true });
    fs.writeFileSync(
      path.join(nativeCodexHome, "config.toml"),
      [
        "[desktop]",
        'conversationDetailMode = "STEPS_COMMANDS"',
        "",
        "[features]",
        "js_repl = false",
        ""
      ].join("\n")
    );

    applyAgentConfig({
      agent: "codex",
      cwd: tmpCwd,
      codexHomeDir: nativeCodexHome,
      codexBaseConfigSourcePath: path.join(tmpHome, "codex", "config.toml")
    });

    const written = fs.readFileSync(path.join(nativeCodexHome, "config.toml"), "utf8");
    const parsed = parseToml(written) as {
      model?: string;
      model_provider?: string;
      model_providers?: Record<string, Record<string, unknown>>;
      desktop?: Record<string, unknown>;
      mcp_servers?: Record<string, Record<string, unknown>>;
    };

    expect(parsed.model).toBe("claude-sonnet-4.6");
    expect(parsed.model_provider).toBe("copillm");
    expect(parsed.model_providers?.copillm.base_url).toBe("http://127.0.0.1:5050/codex/v1");
    expect(parsed.model_providers?.copillm.requires_openai_auth).toBe(false);
    expect(parsed.desktop?.conversationDetailMode).toBe("STEPS_COMMANDS");
    expect(parsed.mcp_servers?.echo.command).toBe("echo");
  });

  it("is idempotent on re-run with the same input", () => {
    fs.writeFileSync(
      path.join(tmpHome, "agent.toml"),
      `
[defaults.mcp.servers.echo]
transport = "stdio"
command = "echo"

[profiles.default]
`
    );
    applyAgentConfig({ agent: "codex", cwd: tmpCwd, codexHomeDir: path.join(tmpHome, "codex") });
    const first = fs.readFileSync(path.join(tmpHome, "codex", "config.toml"), "utf8");
    applyAgentConfig({ agent: "codex", cwd: tmpCwd, codexHomeDir: path.join(tmpHome, "codex") });
    const second = fs.readFileSync(path.join(tmpHome, "codex", "config.toml"), "utf8");
    expect(second).toBe(first);
    // No duplicate marker blocks.
    expect(second.match(/copillm:managed begin/g)?.length).toBe(1);
  });
});
