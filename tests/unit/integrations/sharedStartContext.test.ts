import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Unit tests for the shared-start-context plumbing in PR 2.
 *
 * Audit finding: `copillm start` previously ran up to 3 independent token
 * exchanges, 6 `/models` GETs, 3 keychain reads, and 3 YAML parses because
 * `runDaemon`, `refreshCodexHome`, and `refreshPiHome` each rebuilt their
 * world. The refactor adds an optional `precomputed?: PrecomputedStartContext`
 * parameter on both `generateCodexHome` and `generatePiHome`, which when
 * supplied bypasses the internal `loadConfig` / `loadStoredCredential` /
 * `listModelsUnion` calls. This test pins that behaviour:
 *
 *   1. Without `precomputed`, the loads happen (preserved standalone path).
 *   2. With `precomputed`, the loads do NOT happen (dedup verified).
 *   3. Shared context for two consumers triggers loaders exactly once total.
 */

vi.mock("@napi-rs/keyring", () => ({ AsyncEntry: null, default: null }));

const loadStoredCredentialMock = vi.fn();
const loadConfigMock = vi.fn();
const listModelsUnionMock = vi.fn();

vi.mock("../../../src/auth/credentials.js", () => ({
  loadStoredCredential: (...args: unknown[]) => loadStoredCredentialMock(...args)
}));

vi.mock("../../../src/config/config.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  saveConfig: vi.fn()
}));

vi.mock("../../../src/models/discovery.js", () => ({
  listModelsUnion: (...args: unknown[]) => listModelsUnionMock(...args)
}));

// Catalog with one anthropic-eligible + one codex-eligible model so both
// generators produce a non-empty output. Field shape mirrors the upstream
// Copilot `/models` response (see `src/server/codexSchema.ts`).
const FAKE_CATALOG = [
  {
    id: "fake-anthropic",
    name: "Fake Anthropic",
    vendor: "Anthropic",
    model_picker_enabled: true,
    policy: { state: "enabled" },
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      type: "chat",
      family: "claude",
      tokenizer: "claude",
      limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 }
    }
  },
  {
    id: "gpt-test-codex",
    name: "GPT Test Codex",
    vendor: "OpenAI",
    model_picker_enabled: true,
    policy: { state: "enabled" },
    supported_endpoints: ["/responses"],
    capabilities: {
      type: "chat",
      family: "gpt",
      tokenizer: "o200k_base",
      limits: { max_context_window_tokens: 128_000, max_output_tokens: 32_000 }
    }
  }
];

const FAKE_DISCOVERY = {
  models: FAKE_CATALOG,
  source: "live" as const,
  stale: false,
  cacheAgeSeconds: 0,
  warning: null
};

const FAKE_CREDS = {
  token: "ghu_test_token",
  accountType: "individual" as const,
  source: "session" as const
};

const FAKE_CONFIG = {
  preferredPort: 4141,
  requireCallerSecret: false,
  selectedModels: [],
  accountType: "individual" as const
};

let tmpHome: string;
let tmpCopillmHome: string;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(key: string): void {
  savedEnv[key] = process.env[key];
}

function restoreEnv(key: string): void {
  const original = savedEnv[key];
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-shared-ctx-home-"));
  tmpCopillmHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-shared-ctx-cph-"));
  saveEnv("HOME");
  saveEnv("COPILLM_HOME");
  saveEnv("USERPROFILE");
  saveEnv("HOMEDRIVE");
  saveEnv("HOMEPATH");
  process.env.HOME = tmpHome;
  process.env.COPILLM_HOME = tmpCopillmHome;
  process.env.USERPROFILE = tmpHome;
  const parsed = path.parse(tmpHome);
  process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
  process.env.HOMEPATH = tmpHome.slice(parsed.root.length);

  loadStoredCredentialMock.mockReset();
  loadConfigMock.mockReset();
  listModelsUnionMock.mockReset();
  loadStoredCredentialMock.mockResolvedValue(FAKE_CREDS);
  loadConfigMock.mockReturnValue(FAKE_CONFIG);
  listModelsUnionMock.mockResolvedValue(FAKE_DISCOVERY);
});

afterEach(() => {
  restoreEnv("HOME");
  restoreEnv("COPILLM_HOME");
  restoreEnv("USERPROFILE");
  restoreEnv("HOMEDRIVE");
  restoreEnv("HOMEPATH");
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCopillmHome, { recursive: true, force: true });
});

describe("resolveStartContext", () => {
  it("loads credentials + config + discovery exactly once when called without precomputed", async () => {
    const { resolveStartContext } = await import("../../../src/integrations/codex/init.js");
    const ctx = await resolveStartContext();
    expect(ctx.creds).toEqual(FAKE_CREDS);
    expect(ctx.config).toEqual(FAKE_CONFIG);
    expect(ctx.discovery).toEqual(FAKE_DISCOVERY);
    expect(loadStoredCredentialMock).toHaveBeenCalledTimes(1);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(listModelsUnionMock).toHaveBeenCalledTimes(1);
  });

  it("returns the precomputed context verbatim and performs zero loads", async () => {
    const { resolveStartContext } = await import("../../../src/integrations/codex/init.js");
    const precomputed = { creds: FAKE_CREDS, config: FAKE_CONFIG, discovery: FAKE_DISCOVERY };
    const ctx = await resolveStartContext(precomputed);
    expect(ctx).toBe(precomputed);
    expect(loadStoredCredentialMock).not.toHaveBeenCalled();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(listModelsUnionMock).not.toHaveBeenCalled();
  });

  it("throws when credentials are missing", async () => {
    loadStoredCredentialMock.mockResolvedValueOnce(null);
    const { resolveStartContext } = await import("../../../src/integrations/codex/init.js");
    await expect(resolveStartContext()).rejects.toThrow(/Not authenticated/);
  });
});

describe("generateCodexHome — precomputed context", () => {
  it("with precomputed: skips internal loads (loaders called 0 times)", async () => {
    const { generateCodexHome, defaultOutputDir } = await import("../../../src/integrations/codex/init.js");
    const precomputed = { creds: FAKE_CREDS, config: FAKE_CONFIG, discovery: FAKE_DISCOVERY };
    const result = await generateCodexHome({
      outDir: defaultOutputDir(tmpCopillmHome),
      model: null,
      port: 4141,
      providerId: "copillm",
      reasoningEffort: null,
      precomputed
    });
    expect(result.modelCount).toBeGreaterThan(0);
    expect(loadStoredCredentialMock).not.toHaveBeenCalled();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(listModelsUnionMock).not.toHaveBeenCalled();
  });

  it("without precomputed: still works (preserved standalone behaviour for `copillm codex`)", async () => {
    const { generateCodexHome, defaultOutputDir } = await import("../../../src/integrations/codex/init.js");
    const result = await generateCodexHome({
      outDir: defaultOutputDir(tmpCopillmHome),
      model: null,
      port: 4141,
      providerId: "copillm",
      reasoningEffort: null
    });
    expect(result.modelCount).toBeGreaterThan(0);
    expect(loadStoredCredentialMock).toHaveBeenCalledTimes(1);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(listModelsUnionMock).toHaveBeenCalledTimes(1);
  });
});

describe("generatePiHome — precomputed context", () => {
  it("with precomputed: skips internal loads (loaders called 0 times)", async () => {
    const { generatePiHome, defaultOutputDir } = await import("../../../src/integrations/pi/init.js");
    const precomputed = { creds: FAKE_CREDS, config: FAKE_CONFIG, discovery: FAKE_DISCOVERY };
    const result = await generatePiHome({
      outDir: defaultOutputDir(tmpCopillmHome),
      port: 4141,
      providerId: "copillm",
      precomputed
    });
    expect(result.modelCount).toBeGreaterThan(0);
    expect(loadStoredCredentialMock).not.toHaveBeenCalled();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(listModelsUnionMock).not.toHaveBeenCalled();
  });

  it("without precomputed: still works (preserved standalone behaviour for `copillm pi`)", async () => {
    const { generatePiHome, defaultOutputDir } = await import("../../../src/integrations/pi/init.js");
    const result = await generatePiHome({
      outDir: defaultOutputDir(tmpCopillmHome),
      port: 4141,
      providerId: "copillm"
    });
    expect(result.modelCount).toBeGreaterThan(0);
    expect(loadStoredCredentialMock).toHaveBeenCalledTimes(1);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(listModelsUnionMock).toHaveBeenCalledTimes(1);
  });
});

describe("end-to-end dedup: shared context across both consumers", () => {
  it("loaders fire exactly once total when codex + pi share one precomputed context", async () => {
    const { resolveStartContext, generateCodexHome, defaultOutputDir: codexDefaultDir } = await import(
      "../../../src/integrations/codex/init.js"
    );
    const { generatePiHome, defaultOutputDir: piDefaultDir } = await import(
      "../../../src/integrations/pi/init.js"
    );

    // The caller (daemon.ts) resolves the context once...
    const precomputed = await resolveStartContext();
    expect(loadStoredCredentialMock).toHaveBeenCalledTimes(1);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(listModelsUnionMock).toHaveBeenCalledTimes(1);

    // ...then both generators reuse it without re-loading.
    await generateCodexHome({
      outDir: codexDefaultDir(tmpCopillmHome),
      model: null,
      port: 4141,
      providerId: "copillm",
      reasoningEffort: null,
      precomputed
    });
    await generatePiHome({
      outDir: piDefaultDir(tmpCopillmHome),
      port: 4141,
      providerId: "copillm",
      precomputed
    });

    // Counts unchanged after both generators ran.
    expect(loadStoredCredentialMock).toHaveBeenCalledTimes(1);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(listModelsUnionMock).toHaveBeenCalledTimes(1);
  });

  it("regression guard: WITHOUT shared context, both generators each load independently (3× total)", async () => {
    // This is what the codebase did before PR 2 — pin the bad behaviour as a
    // regression guard so a future caller that drops the shared-context
    // plumbing trips this assertion instead of silently re-introducing the
    // 3-exchange startup flake.
    const { generateCodexHome, defaultOutputDir: codexDefaultDir } = await import(
      "../../../src/integrations/codex/init.js"
    );
    const { generatePiHome, defaultOutputDir: piDefaultDir } = await import(
      "../../../src/integrations/pi/init.js"
    );

    await generateCodexHome({
      outDir: codexDefaultDir(tmpCopillmHome),
      model: null,
      port: 4141,
      providerId: "copillm",
      reasoningEffort: null
    });
    await generatePiHome({
      outDir: piDefaultDir(tmpCopillmHome),
      port: 4141,
      providerId: "copillm"
    });

    expect(loadStoredCredentialMock).toHaveBeenCalledTimes(2);
    expect(loadConfigMock).toHaveBeenCalledTimes(2);
    expect(listModelsUnionMock).toHaveBeenCalledTimes(2);
  });
});
