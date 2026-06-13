import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { buildClaudeEnvBundle, buildCodexEnvBundle, buildPiEnvBundle } from "../../../src/cli/agentEnv.js";

describe("buildClaudeEnvBundle", () => {
  it("includes base url, auth token placeholder, and gateway flag by default", () => {
    const bundle = buildClaudeEnvBundle({
      port: 4141,
      callerSecret: null,
      defaults: { opus: "claude-opus-4.7", sonnet: "claude-sonnet-4.6", haiku: "claude-haiku-4.5" }
    });
    expect(bundle.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141/anthropic");
    expect(bundle.env.ANTHROPIC_AUTH_TOKEN).toBe("copillm-local");
    expect(bundle.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(bundle.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4.7");
    expect(bundle.trailingNotes).toEqual([]);
  });

  it("uses the caller secret when provided", () => {
    const bundle = buildClaudeEnvBundle({
      port: 9999,
      callerSecret: "secret-token-xyz",
      defaults: { opus: null, sonnet: null, haiku: null },
      enableGatewayDiscovery: false
    });
    expect(bundle.env.ANTHROPIC_AUTH_TOKEN).toBe("secret-token-xyz");
    expect(bundle.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();
  });

  it("emits trailing notes for missing variants and omits the env vars", () => {
    const bundle = buildClaudeEnvBundle({
      port: 4141,
      callerSecret: null,
      defaults: { opus: null, sonnet: "claude-sonnet-4.6", haiku: null }
    });
    expect(bundle.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(bundle.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4.6");
    expect(bundle.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(bundle.trailingNotes.some((n) => n.includes("opus"))).toBe(true);
    expect(bundle.trailingNotes.some((n) => n.includes("haiku"))).toBe(true);
  });
});

describe("buildCodexEnvBundle", () => {
  it("returns CODEX_HOME mapped to the supplied directory", () => {
    const bundle = buildCodexEnvBundle("/tmp/codex");
    expect(bundle.env).toEqual({ CODEX_HOME: "/tmp/codex" });
    expect(bundle.inlineComments).toEqual({});
    expect(bundle.trailingNotes).toEqual([]);
  });
});

describe("buildPiEnvBundle", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  });

  it("exports PI_CODING_AGENT_DIR pointing at the copillm-owned pi agent dir", () => {
    // copillm owns pi's config dir via PI_CODING_AGENT_DIR (pi added this
    // override; copillm no longer writes the user's real ~/.pi). Anyone reading
    // this test must update both the implementation and these expectations.
    process.env.PI_CODING_AGENT_DIR = path.join(path.sep, "tmp", "pi-agent");
    const bundle = buildPiEnvBundle("/tmp/pi");
    expect(bundle.env).toEqual({ PI_CODING_AGENT_DIR: path.resolve(path.join(path.sep, "tmp", "pi-agent")) });
    expect(bundle.inlineComments).toEqual({});
    expect(bundle.trailingNotes.length).toBeGreaterThan(0);
    // The notes must reference the env var copillm sets and the mirror dir.
    expect(bundle.trailingNotes.some((n) => n.includes("PI_CODING_AGENT_DIR"))).toBe(true);
    expect(bundle.trailingNotes.some((n) => n.includes("/tmp/pi/models.json"))).toBe(true);
  });
});
