import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keytar is never available in CI; force the keytar-import path to no-op so we
// don't probe the system keychain when loadStoredCredential is hit indirectly.
vi.mock("keytar", () => ({ default: null }));

// Mock the credential loader so the test does not require real GitHub auth.
vi.mock("../src/auth/credentials.js", () => ({
  loadStoredCredential: vi.fn(async () => ({
    token: "ghu_test_token",
    accountType: "individual",
    source: "session"
  }))
}));

// Mock the Copilot token manager so ensureToken() does not make a network call.
vi.mock("../src/auth/copilotToken.js", () => {
  class FakeCopilotTokenManager {
    public constructor(_token: string) {
      // no-op
    }
    public async ensureToken(): Promise<string> {
      return "copilot_test_token";
    }
  }
  return { CopilotTokenManager: FakeCopilotTokenManager };
});

// Mock model discovery so we do not hit Copilot. The shapes mirror the fields
// pi-init reads from the upstream catalog. Ids are intentionally fictional to
// avoid baking real upstream model names into the test surface. The mock
// exercises all the branches of pi-init's two-provider split:
//   - chat-only (large context)  → Anthropic-messages provider entry
//   - chat + responses           → Anthropic-messages provider entry (we don't
//                                  double-list a model just because it also
//                                  supports /responses)
//   - responses-only             → openai-responses provider entry
//   - duplicate id               → de-duped
//   - picker_enabled: false      → filtered out entirely
//   - policy.state: "disabled"   → filtered out entirely
const ELIGIBLE_META = {
  model_picker_enabled: true,
  policy: { state: "enabled" }
} as const;
vi.mock("../src/models/discovery.js", () => ({
  listModelsUnion: vi.fn(async () => ({
    models: [
      {
        id: "fake-anthropic-1m",
        ...ELIGIBLE_META,
        supported_endpoints: ["/chat/completions"],
        capabilities: { limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 32_000 } }
      },
      {
        id: "fake-anthropic-1m",
        ...ELIGIBLE_META,
        supported_endpoints: ["/chat/completions"],
        capabilities: { limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 32_000 } }
      }, // duplicate id; should dedupe within the chat provider
      {
        id: "fake-gpt-dual",
        ...ELIGIBLE_META,
        supported_endpoints: ["/chat/completions", "/responses"],
        capabilities: { limits: { max_context_window_tokens: 1_050_000, max_output_tokens: 128_000 } }
      },
      {
        id: "fake-gpt-responses-only",
        ...ELIGIBLE_META,
        supported_endpoints: ["/responses"],
        capabilities: { limits: { max_context_window_tokens: 400_000, max_output_tokens: 64_000 } }
      },
      {
        id: "fake-gemini",
        ...ELIGIBLE_META,
        supported_endpoints: ["/chat/completions"],
        capabilities: { limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 8_192 } }
      },
      // Not picker-eligible — must be filtered out before reaching either provider.
      {
        id: "fake-disabled-picker",
        model_picker_enabled: false,
        supported_endpoints: ["/chat/completions"],
        capabilities: { limits: { max_context_window_tokens: 200_000, max_output_tokens: 4_096 } }
      },
      {
        id: "fake-disabled-policy",
        model_picker_enabled: true,
        policy: { state: "disabled" },
        supported_endpoints: ["/responses"],
        capabilities: { limits: { max_context_window_tokens: 200_000, max_output_tokens: 4_096 } }
      }
    ]
  }))
}));

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-pi-init-home-"));
  tmpCopillmHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-pi-init-cph-"));
  saveEnv("HOME");
  saveEnv("COPILLM_HOME");
  saveEnv("USERPROFILE");
  saveEnv("HOMEDRIVE");
  saveEnv("HOMEPATH");
  // os.homedir() consults different env vars per platform:
  //   - POSIX: HOME
  //   - Windows: USERPROFILE, then HOMEDRIVE+HOMEPATH
  // Override all of them so this test never touches the real user profile,
  // regardless of which platform vitest runs on.
  process.env.HOME = tmpHome;
  process.env.COPILLM_HOME = tmpCopillmHome;
  process.env.USERPROFILE = tmpHome;
  const parsed = path.parse(tmpHome);
  process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
  process.env.HOMEPATH = tmpHome.slice(parsed.root.length);
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

describe("generatePiHome", () => {
  it("writes a two-provider models.json with per-model context windows and routes /responses-only models separately", async () => {
    const { generatePiHome, defaultOutputDir, piModelsJsonPath } = await import(
      "../src/pi/init.js"
    );

    const outDir = defaultOutputDir(tmpCopillmHome);
    const result = await generatePiHome({ outDir, port: 4242, providerId: "copillm" });

    expect(result.outDir).toBe(path.resolve(outDir));
    expect(result.anthropicModelCount).toBe(3); // 1m + dual + gemini (dup deduped, ineligibles filtered)
    expect(result.responsesModelCount).toBe(1); // responses-only
    expect(result.modelCount).toBe(4);
    expect(result.proxyUrl).toBe("http://127.0.0.1:4242/anthropic");
    expect(result.responsesProxyUrl).toBe("http://127.0.0.1:4242/codex/v1");
    expect(result.backupPath).toBeNull(); // no pre-existing pi config

    // Mirror written under copillm home.
    expect(result.mirrorPath).toBe(path.join(outDir, "models.json"));
    expect(fs.existsSync(result.mirrorPath)).toBe(true);

    // Real pi config written under $HOME/.pi/agent/models.json.
    expect(result.configPath).toBe(piModelsJsonPath());
    expect(result.configPath).toBe(path.join(tmpHome, ".pi", "agent", "models.json"));
    expect(fs.existsSync(result.configPath)).toBe(true);

    const mirror = JSON.parse(fs.readFileSync(result.mirrorPath, "utf8"));
    const real = JSON.parse(fs.readFileSync(result.configPath, "utf8"));
    expect(mirror).toEqual(real);

    // Anthropic-messages provider: contextWindow/maxTokens propagated from
    // upstream capabilities so pi's autocompact logic uses the real budget
    // (not pi's 128000/16384 defaults). Models that advertise BOTH
    // /chat/completions and /responses (fake-gpt-dual) flow through this
    // provider, not the responses provider, so pi doesn't double-list them.
    expect(mirror.providers.copillm).toEqual({
      baseUrl: "http://127.0.0.1:4242/anthropic",
      api: "anthropic-messages",
      apiKey: "copillm-local",
      models: [
        { id: "fake-anthropic-1m", contextWindow: 1_000_000, maxTokens: 32_000 },
        { id: "fake-gpt-dual", contextWindow: 1_050_000, maxTokens: 128_000 },
        { id: "fake-gemini", contextWindow: 1_000_000, maxTokens: 8_192 }
      ]
    });

    // OpenAI-responses provider: only models that copillm's /chat/completions
    // route can't serve. baseUrl includes /v1 because the OpenAI SDK pi uses
    // posts to `<baseUrl>/responses`.
    expect(mirror.providers["copillm-responses"]).toEqual({
      baseUrl: "http://127.0.0.1:4242/codex/v1",
      api: "openai-responses",
      apiKey: "copillm-local",
      models: [
        { id: "fake-gpt-responses-only", contextWindow: 400_000, maxTokens: 64_000 }
      ]
    });
  });

  it("backs up a pre-existing models.json when the new content differs", async () => {
    const { generatePiHome, defaultOutputDir, piModelsJsonPath } = await import(
      "../src/pi/init.js"
    );

    // Seed an unrelated pre-existing config that pi would have read.
    const existingPath = piModelsJsonPath();
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, JSON.stringify({ providers: { other: {} } }, null, 2));

    const outDir = defaultOutputDir(tmpCopillmHome);
    const result = await generatePiHome({ outDir, port: 9001, providerId: "copillm" });

    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath!.startsWith(`${existingPath}.copillm-backup-`)).toBe(true);
    expect(result.backupPath!.endsWith(".bak")).toBe(true);
    expect(fs.existsSync(result.backupPath!)).toBe(true);

    // Backup retains the pre-existing payload, not the new one.
    const backed = JSON.parse(fs.readFileSync(result.backupPath!, "utf8"));
    expect(backed).toEqual({ providers: { other: {} } });

    // And the live file is the new copillm-managed payload.
    const live = JSON.parse(fs.readFileSync(existingPath, "utf8"));
    expect(live.providers.copillm.baseUrl).toBe("http://127.0.0.1:9001/anthropic");
  });

  it("does NOT create a backup when the existing file is byte-identical", async () => {
    const { generatePiHome, defaultOutputDir, piModelsJsonPath } = await import(
      "../src/pi/init.js"
    );

    // First call produces the canonical file; second call must not back it up.
    const outDir = defaultOutputDir(tmpCopillmHome);
    const first = await generatePiHome({ outDir, port: 4242, providerId: "copillm" });
    expect(first.backupPath).toBeNull();

    const second = await generatePiHome({ outDir, port: 4242, providerId: "copillm" });
    expect(second.backupPath).toBeNull();

    // Sanity: only the one file exists; no stray backups landed alongside it.
    const piAgentDir = path.dirname(piModelsJsonPath());
    const entries = fs.readdirSync(piAgentDir);
    expect(entries.filter((e) => e.includes(".copillm-backup-"))).toEqual([]);
  });

  it("falls back to provider id 'copillm' when given whitespace", async () => {
    const { generatePiHome, defaultOutputDir } = await import("../src/pi/init.js");
    const outDir = defaultOutputDir(tmpCopillmHome);
    const result = await generatePiHome({ outDir, port: 5555, providerId: "   " });
    const live = JSON.parse(fs.readFileSync(result.configPath, "utf8"));
    // The Anthropic-messages provider uses the id verbatim; the
    // openai-responses provider appends `-responses` to disambiguate.
    expect(Object.keys(live.providers).sort()).toEqual(["copillm", "copillm-responses"]);
  });
});
