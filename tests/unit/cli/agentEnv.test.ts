import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildClaudeEnvBundle,
  buildCodexEnvBundle,
  buildCopilotEnvOverlay,
  buildPiEnvBundle
} from "../../../src/cli/agentEnv.js";

describe("buildClaudeEnvBundle", () => {
  it("includes base url, auth token placeholder, and gateway flag by default", () => {
    const bundle = buildClaudeEnvBundle({
      port: 4141,
      callerSecret: null,
      defaults: { opus: "claude-opus-4-7", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5" }
    });
    expect(bundle.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141/anthropic");
    expect(bundle.env.ANTHROPIC_AUTH_TOKEN).toBe("copillm-local");
    expect(bundle.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(bundle.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7");
    expect(bundle.trailingNotes).toEqual([]);
  });

  it("points CLAUDE_CONFIG_DIR at the copillm-owned config home", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(path.sep, "tmp", "claude-home");
    try {
      const bundle = buildClaudeEnvBundle({
        port: 4141,
        callerSecret: null,
        defaults: { opus: null, sonnet: null, haiku: null }
      });
      // An explicit CLAUDE_CONFIG_DIR wins (resolved), so copillm-launched Claude
      // never reads the user's real ~/.claude.
      expect(bundle.env.CLAUDE_CONFIG_DIR).toBe(path.resolve(path.join(path.sep, "tmp", "claude-home")));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
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

  it("uses the profile-specific Claude config home when isolated", () => {
    const savedHome = process.env.COPILLM_HOME;
    const savedConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.COPILLM_HOME = path.join(path.sep, "tmp", "copillm-profile-home");
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const expectedHome = path.resolve(process.env.COPILLM_HOME);
      const bundle = buildClaudeEnvBundle({
        port: 4141,
        callerSecret: null,
        defaults: { opus: null, sonnet: null, haiku: null },
        sessionScope: "isolated",
        profileName: "personal"
      });
      expect(bundle.env.CLAUDE_CONFIG_DIR).toBe(
        path.join(expectedHome, "profiles", "personal", "claude", "home")
      );
    } finally {
      if (savedHome === undefined) delete process.env.COPILLM_HOME;
      else process.env.COPILLM_HOME = savedHome;
      if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedConfig;
    }
  });

  it("emits trailing notes for missing variants and omits the env vars", () => {
    const bundle = buildClaudeEnvBundle({
      port: 4141,
      callerSecret: null,
      defaults: { opus: null, sonnet: "claude-sonnet-4-6", haiku: null }
    });
    expect(bundle.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(bundle.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-6");
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

  it("exports the profile-specific pi agent dir when isolated", () => {
    const savedHome = process.env.COPILLM_HOME;
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.COPILLM_HOME = path.join(path.sep, "tmp", "copillm-profile-home");
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      const expectedHome = path.resolve(process.env.COPILLM_HOME);
      const bundle = buildPiEnvBundle("/tmp/pi", "isolated", "personal");
      expect(bundle.env.PI_CODING_AGENT_DIR).toBe(
        path.join(expectedHome, "profiles", "personal", "pi", "agent")
      );
    } finally {
      if (savedHome === undefined) delete process.env.COPILLM_HOME;
      else process.env.COPILLM_HOME = savedHome;
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    }
  });
});

describe("buildCopilotEnvOverlay", () => {
  it("does not set COPILOT_HOME for shared profiles", () => {
    expect(buildCopilotEnvOverlay("shared", "work")).toEqual({});
  });

  it("sets COPILOT_HOME only for isolated profiles", () => {
    const savedHome = process.env.COPILLM_HOME;
    const savedCopilot = process.env.COPILOT_HOME;
    process.env.COPILLM_HOME = path.join(path.sep, "tmp", "copillm-profile-home");
    delete process.env.COPILOT_HOME;
    try {
      const expectedHome = path.resolve(process.env.COPILLM_HOME);
      expect(buildCopilotEnvOverlay("isolated", "personal")).toEqual({
        COPILOT_HOME: path.join(expectedHome, "profiles", "personal", "copilot")
      });
    } finally {
      if (savedHome === undefined) delete process.env.COPILLM_HOME;
      else process.env.COPILLM_HOME = savedHome;
      if (savedCopilot === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = savedCopilot;
    }
  });
});
