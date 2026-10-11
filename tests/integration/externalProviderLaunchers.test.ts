import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliPath = path.resolve(__dirname, "..", "..", "dist", "cli.js");

let shimDir: string | undefined;
let dumpPath: string | undefined;

function writeAgentShim(dir: string, agent: "codex" | "pi", outputPath: string): void {
  const script = `
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("shim 0.0.0\\n");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
  agent: ${JSON.stringify(agent)},
  args: process.argv.slice(2),
  CODEX_HOME: process.env.CODEX_HOME ?? "",
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? "",
  COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN ?? ""
}) + "\\n");
`;

  if (process.platform === "win32") {
    const jsPath = path.join(dir, `${agent}-shim.js`);
    fs.writeFileSync(jsPath, script);
    fs.writeFileSync(
      path.join(dir, `${agent}.cmd`),
      `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`
    );
    return;
  }

  const binPath = path.join(dir, agent);
  fs.writeFileSync(binPath, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
}

function writeExternalProfile(home: string): void {
  fs.writeFileSync(
    path.join(home, "agent.toml"),
    `
active_profile = "local"

[profiles.local.provider]
id = "local-provider"
name = "Local Provider"
base_url = "http://127.0.0.1:8000/v1"
model = "local-test-model"
supports_chat_completions = true
supports_responses = true

[profiles.local.provider.pi]
api = "openai-completions"
`
  );
}

function launch(
  agent: "codex" | "pi",
  home: string
): ReturnType<typeof spawnSync> {
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}${pathSeparator}${process.env.PATH ?? ""}`,
    COPILLM_HOME: home,
    COPILLM_PROFILE: "local",
    COPILLM_USE_SYSTEM_AGENT: "1"
  };
  delete env.COPILLM_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  return spawnSync(process.execPath, [cliPath, agent], {
    env,
    encoding: "utf8",
    timeout: 30_000
  });
}

beforeAll(() => {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI artifact missing at ${cliPath} — globalSetup did not run.`);
  }
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-external-agent-shim-"));
  dumpPath = path.join(shimDir, "launch.json");
  writeAgentShim(shimDir, "codex", dumpPath);
  writeAgentShim(shimDir, "pi", dumpPath);
});

afterAll(() => {
  if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true });
});

describe("external provider agent launchers", () => {
  it("launches Codex without the daemon or a GitHub credential", () => {
    if (!shimDir || !dumpPath) throw new Error("test setup did not complete");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-external-codex-"));
    try {
      writeExternalProfile(home);

      const result = launch("codex", home);

      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Not authenticated");
      expect(result.stderr).not.toContain("Not authenticated");
      expect(fs.existsSync(path.join(home, "copillm.pid"))).toBe(false);

      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8")) as {
        agent: string;
        CODEX_HOME: string;
        PI_CODING_AGENT_DIR: string;
        COPILOT_GITHUB_TOKEN: string;
      };
      const expectedHome = path.join(home, "codex");
      expect(dump.agent).toBe("codex");
      expect(dump.CODEX_HOME).toBe(expectedHome);
      expect(dump.PI_CODING_AGENT_DIR).toBe("");
      expect(dump.COPILOT_GITHUB_TOKEN).toBe("");

      const config = parseToml(fs.readFileSync(path.join(expectedHome, "config.toml"), "utf8")) as {
        model?: string;
        model_provider?: string;
        model_providers?: Record<string, { base_url?: string; wire_api?: string }>;
      };
      expect(config.model).toBe("local-test-model");
      expect(config.model_provider).toBe("local-provider");
      expect(config.model_providers?.["local-provider"]).toMatchObject({
        base_url: "http://127.0.0.1:8000/v1",
        wire_api: "responses"
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("launches pi without the daemon or a GitHub credential", () => {
    if (!shimDir || !dumpPath) throw new Error("test setup did not complete");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-external-pi-"));
    try {
      writeExternalProfile(home);

      const result = launch("pi", home);

      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Not authenticated");
      expect(result.stderr).not.toContain("Not authenticated");
      expect(fs.existsSync(path.join(home, "copillm.pid"))).toBe(false);

      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8")) as {
        agent: string;
        CODEX_HOME: string;
        PI_CODING_AGENT_DIR: string;
        COPILOT_GITHUB_TOKEN: string;
      };
      const expectedAgentDir = path.join(home, "pi", "agent");
      expect(dump.agent).toBe("pi");
      expect(dump.CODEX_HOME).toBe("");
      expect(dump.PI_CODING_AGENT_DIR).toBe(expectedAgentDir);
      expect(dump.COPILOT_GITHUB_TOKEN).toBe("");

      const models = JSON.parse(
        fs.readFileSync(path.join(expectedAgentDir, "models.json"), "utf8")
      ) as {
        providers?: Record<string, {
          api?: string;
          baseUrl?: string;
          apiKey?: string;
          models?: Array<{ id?: string }>;
        }>;
      };
      expect(models.providers?.["local-provider"]).toMatchObject({
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "copillm-local",
        models: [{ id: "local-test-model" }]
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
