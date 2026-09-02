import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentConfig } from "../../../src/agentconfig/apply.js";

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
  // pi config resolves under COPILLM_HOME unless explicitly overridden.
  delete process.env.PI_CODING_AGENT_DIR;
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

  it("writes native Claude settings and user MCP config for explicit sync", () => {
    writeGlobal(`
[defaults.mcp.servers.copillm-github]
transport = "http"
url = "https://example.com/mcp"
headers = { Authorization = "Bearer abc" }
[profiles.default]
`);
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "user-owned": { type: "stdio", command: "true" } } })
    );
    fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ env: { EXISTING: "1" }, theme: "dark" })
    );

    const result = applyAgentConfig({
      agent: "claude",
      cwd: tmpCwd,
      claudeNativeSync: true,
      claudeEnv: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4141/anthropic",
        ANTHROPIC_AUTH_TOKEN: "copillm-local"
      }
    });

    expect(result.cliArgs).toEqual([]);

    const userConfig = JSON.parse(fs.readFileSync(path.join(tmpHome, ".claude.json"), "utf8"));
    expect(userConfig.mcpServers["user-owned"]).toBeDefined();
    expect(userConfig.mcpServers["copillm-github"]).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc" }
    });

    const settings = JSON.parse(fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.env.EXISTING).toBe("1");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141/anthropic");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("copillm-local");
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
    const extDir = path.join(tmpHome, "pi", "agent", "extensions", "copillm-mcp");
    expect(fs.existsSync(path.join(extDir, "index.ts"))).toBe(true);
    const servers = JSON.parse(fs.readFileSync(path.join(extDir, "servers.json"), "utf8"));
    expect(servers.servers.echo.command).toBe("echo");
  });
});

describe("applyAgentConfig — external provider", () => {
  const providerKey = "TEST_EXTERNAL_PROVIDER_KEY";
  const providerSecret = "provider-secret-must-not-be-written";

  afterEach(() => {
    delete process.env[providerKey];
  });

  function writeProviderProfile(extra = ""): void {
    writeGlobal(`
[profiles.default.provider]
id = "local-llm"
name = "Local LLM"
base_url = "http://127.0.0.1:8000/v1"
model = "local-test-model"
api_key_env = "${providerKey}"
context_window = 262144
max_output_tokens = 32768
input = ["text"]
reasoning = true
supports_responses = true

[profiles.default.provider.pi]
api = "openai-completions"
auth_header = true

[profiles.default.provider.pi.compat]
supports_developer_role = false
supports_reasoning_effort = false
requires_tool_result_name = true
thinking_format = "qwen"

[profiles.default.provider.codex]
reasoning_effort = "medium"

[profiles.default.provider.copilot]
offline = true
${extra}
`);
  }

  it("renders Codex and pi native configuration without persisting the key", () => {
    process.env[providerKey] = providerSecret;
    writeProviderProfile();

    const codexHome = path.join(tmpHome, "codex");
    fs.mkdirSync(codexHome, { recursive: true });
    const codex = applyAgentConfig({
      agent: "codex",
      cwd: tmpCwd,
      codexHomeDir: codexHome
    });
    const codexConfig = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(codexConfig).toContain('model = "local-test-model"');
    expect(codexConfig).toContain('model_provider = "local-llm"');
    expect(codexConfig).toContain('env_key = "TEST_EXTERNAL_PROVIDER_KEY"');
    expect(codexConfig).not.toContain(providerSecret);

    const pi = applyAgentConfig({ agent: "pi", cwd: tmpCwd });
    const piConfig = JSON.parse(
      fs.readFileSync(path.join(tmpHome, "pi", "agent", "models.json"), "utf8")
    ) as {
      providers: Record<string, {
        apiKey: string;
        api: string;
        baseUrl: string;
        models: Array<Record<string, unknown>>;
        authHeader?: boolean;
        compat?: Record<string, unknown>;
      }>;
    };
    const provider = piConfig.providers["local-llm"];
    expect(provider.apiKey).toBe("$TEST_EXTERNAL_PROVIDER_KEY");
    expect(provider.authHeader).toBe(true);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models[0]).toMatchObject({
      id: "local-test-model",
      name: "Local LLM",
      contextWindow: 262144,
      maxTokens: 32768,
      reasoning: true,
      input: ["text"]
    });
    expect(provider.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      requiresToolResultName: true,
      thinkingFormat: "qwen"
    });
    expect(JSON.stringify(piConfig)).not.toContain(providerSecret);
    expect(pi.notes).toContain('using external provider "local-llm" for pi');
  });

  it("renders Copilot BYOK environment without writing the key", () => {
    process.env[providerKey] = providerSecret;
    writeProviderProfile();

    const result = applyAgentConfig({ agent: "copilot", cwd: tmpCwd });
    expect(result.envOverlay).toMatchObject({
      COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:8000/v1",
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_MODEL: "local-test-model",
      COPILOT_PROVIDER_API_KEY: providerSecret,
      COPILOT_OFFLINE: "true"
    });
    expect(result.writes.every((write) => !write.content.includes(providerSecret))).toBe(true);
  });

  it("fails before writing when a referenced provider key is missing", () => {
    delete process.env[providerKey];
    writeProviderProfile();

    expect(() => applyAgentConfig({ agent: "copilot", cwd: tmpCwd })).toThrow(
      /TEST_EXTERNAL_PROVIDER_KEY/
    );
    expect(fs.existsSync(path.join(tmpHome, "copilot", "mcp-config.json"))).toBe(false);
  });
});

describe("applyAgentConfig — copilot", () => {
  it("writes Copilot MCP config and emits --additional-mcp-config CLI args", () => {
    writeGlobal(`
[defaults.mcp.servers.always_on]
transport = "stdio"
command = "echo"
args = ["default"]
env = { DEFAULT_ENV = "1" }
cwd = "/tmp"

[profiles.work.mcp.servers.remote]
transport = "http"
url = "https://example.com/mcp"
headers = { Authorization = "Bearer abc", X_Trace = "1" }
`);

    const result = applyAgentConfig({ agent: "copilot", cwd: tmpCwd, profileOverride: "work" });
    const managedPath = path.join(tmpHome, "copilot", "mcp-config.json");

    expect(result.cliArgs).toEqual(["--additional-mcp-config", `@${managedPath}`]);
    expect(result.notes).toEqual([]);
    expect(fs.existsSync(managedPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(managedPath, "utf8"));
    expect(written.mcpServers.always_on).toEqual({
      type: "local",
      command: "echo",
      tools: ["*"],
      args: ["default"],
      env: { DEFAULT_ENV: "1" },
      cwd: "/tmp"
    });
    expect(written.mcpServers.remote).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      tools: ["*"],
      headers: { Authorization: "Bearer abc", X_Trace: "1" }
    });
  });

  it("removes stale managed config when profile no longer declares any servers", () => {
    writeGlobal(`
[defaults.mcp.servers.first]
transport = "http"
url = "https://example.com/a"
[profiles.default]
`);
    applyAgentConfig({ agent: "copilot", cwd: tmpCwd });
    const managedPath = path.join(tmpHome, "copilot", "mcp-config.json");
    expect(fs.existsSync(managedPath)).toBe(true);

    writeGlobal(`[profiles.default]\n`);
    const result = applyAgentConfig({ agent: "copilot", cwd: tmpCwd });
    expect(fs.existsSync(managedPath)).toBe(false);
    expect(result.cliArgs).toEqual([]);
  });
});

describe("applyAgentConfig — isolated profile state", () => {
  it("keeps generated files separate for Claude, Codex, pi, and Copilot", () => {
    writeGlobal(`
[profiles.personal]
session_scope = "isolated"

[profiles.personal.mcp.servers.profile_server]
transport = "stdio"
command = "echo"
args = ["personal"]
`);

    const profileRoot = path.join(tmpHome, "profiles", "personal");
    const codexHome = path.join(profileRoot, "codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model = "fake-model"',
        'model_provider = "copillm"',
        "",
        "[model_providers.copillm]",
        'base_url = "http://127.0.0.1:4141/codex/v1"',
        ""
      ].join("\n")
    );

    const claude = applyAgentConfig({
      agent: "claude",
      cwd: tmpCwd,
      profileOverride: "personal"
    });
    const codex = applyAgentConfig({
      agent: "codex",
      cwd: tmpCwd,
      profileOverride: "personal",
      codexHomeDir: codexHome
    });
    const pi = applyAgentConfig({
      agent: "pi",
      cwd: tmpCwd,
      profileOverride: "personal"
    });
    const copilot = applyAgentConfig({
      agent: "copilot",
      cwd: tmpCwd,
      profileOverride: "personal"
    });

    const claudePath = path.join(profileRoot, "claude", "mcp.json");
    const copilotPath = path.join(profileRoot, "copilot", "mcp-config.json");
    expect(claude.cliArgs).toEqual(["--mcp-config", claudePath]);
    expect(fs.existsSync(claudePath)).toBe(true);
    expect(codex.writes.some((write) => write.path.startsWith(codexHome))).toBe(true);
    expect(fs.existsSync(path.join(profileRoot, "pi", "agent", "extensions", "copillm-mcp", "servers.json"))).toBe(
      true
    );
    expect(copilot.cliArgs).toEqual(["--additional-mcp-config", `@${copilotPath}`]);
    expect(fs.existsSync(copilotPath)).toBe(true);

    expect(fs.existsSync(path.join(tmpHome, "claude", "mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, "copilot", "mcp-config.json"))).toBe(false);
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
