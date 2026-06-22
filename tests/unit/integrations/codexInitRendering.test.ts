import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Audit finding (high): the previous `renderConfigToml` built `~/.codex/config.toml`
 * by raw string interpolation. An upstream-controlled model id (or a future
 * attacker-influenced providerId/reasoningEffort) carrying `"` + `\n[mcp_servers.x]`
 * could inject a top-level table, which codex then honours on launch — RCE via
 * a malicious MCP entry on the next codex run.
 *
 * Two layers of defence land in src/integrations/codex/init.ts:
 *   1. The renderer uses `stringifyToml` so string values are quote/escaped.
 *   2. A slug allowlist (`/^[A-Za-z0-9._-]+$/`) refuses anything outside the
 *      conservative charset BEFORE the renderer ever sees it.
 *
 * These tests pin both layers.
 */

vi.mock("@napi-rs/keyring", () => ({ AsyncEntry: null, default: null }));

const FAKE_DISCOVERY = (id: string) => ({
  models: [
    {
      id,
      name: id,
      vendor: "OpenAI",
      model_picker_enabled: true,
      policy: { state: "enabled" },
      supported_endpoints: ["/responses"],
      capabilities: { type: "chat", family: "gpt", tokenizer: "o200k_base" }
    }
  ],
  source: "live" as const,
  stale: false,
  cacheAgeSeconds: 0,
  warning: null
});

const FAKE_CONFIG = {
  preferredPort: 4141,
  requireCallerSecret: false,
  selectedModels: [],
  accountType: "individual" as const
};

const FAKE_CREDS = {
  token: "ghu_test",
  accountType: "individual" as const,
  source: "session" as const
};

let tmpHome: string;
const saved: Record<string, string | undefined> = {};

function saveEnv(key: string): void {
  saved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-codex-render-"));
  saveEnv("HOME");
  saveEnv("COPILLM_HOME");
  process.env.HOME = tmpHome;
  process.env.COPILLM_HOME = tmpHome;
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

describe("renderConfigToml safety (codex init)", () => {
  it("a normal model id round-trips through a TOML parser", async () => {
    const { generateCodexHome, defaultOutputDir } = await import(
      "../../../src/integrations/codex/init.js"
    );
    const result = await generateCodexHome({
      outDir: defaultOutputDir(tmpHome),
      model: null,
      port: 4141,
      providerId: "copillm",
      reasoningEffort: null,
      precomputed: { creds: FAKE_CREDS, config: FAKE_CONFIG, discovery: FAKE_DISCOVERY("gpt-5.2-codex") }
    });

    const body = fs.readFileSync(result.configPath, "utf8");
    const parsed = parseToml(body) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-5.2-codex");
    expect(parsed.model_provider).toBe("copillm");
    expect(parsed.model_reasoning_effort).toBe("medium");
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    expect(providers.copillm.base_url).toBe("http://127.0.0.1:4141/codex/v1");
    expect(providers.copillm.wire_api).toBe("responses");
    expect(providers.copillm.requires_openai_auth).toBe(false);
    // Hostile-table-injection guard: the rendered file must NOT contain any
    // table other than [model_providers.copillm].
    const tableHeaders = body.match(/^\[[^\]]+\]/gm) ?? [];
    expect(tableHeaders).toEqual(["[model_providers.copillm]"]);
  });

  it("rejects an upstream model id that contains a quote", async () => {
    const { generateCodexHome, defaultOutputDir, CodexInitError } = await import(
      "../../../src/integrations/codex/init.js"
    );
    await expect(
      generateCodexHome({
        outDir: defaultOutputDir(tmpHome),
        model: null,
        port: 4141,
        providerId: "copillm",
        reasoningEffort: null,
        precomputed: {
          creds: FAKE_CREDS,
          config: FAKE_CONFIG,
          discovery: FAKE_DISCOVERY('foo"\n[mcp_servers.evil]\ncommand = "sh"')
        }
      })
    ).rejects.toBeInstanceOf(CodexInitError);

    // And nothing must have been written to disk — the throw happens before
    // writeFileSecureAtomic.
    expect(fs.existsSync(path.join(tmpHome, "codex", "config.toml"))).toBe(false);
  });

  it("rejects an upstream model id that contains a newline", async () => {
    const { generateCodexHome, defaultOutputDir, CodexInitError } = await import(
      "../../../src/integrations/codex/init.js"
    );
    await expect(
      generateCodexHome({
        outDir: defaultOutputDir(tmpHome),
        model: null,
        port: 4141,
        providerId: "copillm",
        reasoningEffort: null,
        precomputed: {
          creds: FAKE_CREDS,
          config: FAKE_CONFIG,
          discovery: FAKE_DISCOVERY("foo\nbar")
        }
      })
    ).rejects.toBeInstanceOf(CodexInitError);
  });

  it("rejects an out-of-charset providerId (defence in depth: future caller)", async () => {
    const { generateCodexHome, defaultOutputDir, CodexInitError } = await import(
      "../../../src/integrations/codex/init.js"
    );
    await expect(
      generateCodexHome({
        outDir: defaultOutputDir(tmpHome),
        model: null,
        port: 4141,
        providerId: 'copillm"\n[evil]',
        reasoningEffort: null,
        precomputed: { creds: FAKE_CREDS, config: FAKE_CONFIG, discovery: FAKE_DISCOVERY("gpt-test") }
      })
    ).rejects.toBeInstanceOf(CodexInitError);
  });

  it("rejects an out-of-charset reasoningEffort", async () => {
    const { generateCodexHome, defaultOutputDir, CodexInitError } = await import(
      "../../../src/integrations/codex/init.js"
    );
    await expect(
      generateCodexHome({
        outDir: defaultOutputDir(tmpHome),
        model: null,
        port: 4141,
        providerId: "copillm",
        reasoningEffort: 'high"\n[evil]',
        precomputed: { creds: FAKE_CREDS, config: FAKE_CONFIG, discovery: FAKE_DISCOVERY("gpt-test") }
      })
    ).rejects.toBeInstanceOf(CodexInitError);
  });
});
