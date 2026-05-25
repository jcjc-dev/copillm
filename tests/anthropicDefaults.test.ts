import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_FAMILIES,
  buildClaudeExportCommand,
  computeAnthropicDefaults
} from "../src/models/anthropicDefaults.js";

describe("anthropicDefaults.computeAnthropicDefaults", () => {
  it("picks the highest version plain variant per family", () => {
    const defaults = computeAnthropicDefaults([
      "claude-opus-4.5",
      "claude-opus-4.7",
      "claude-opus-4.7-high",
      "claude-opus-4.7-xhigh",
      "claude-opus-4.7-1m",
      "claude-sonnet-4.5",
      "claude-sonnet-4.6",
      "claude-haiku-4.5",
      "gpt-5.4"
    ]);
    expect(defaults).toEqual({
      opus: "claude-opus-4.7",
      sonnet: "claude-sonnet-4.6",
      haiku: "claude-haiku-4.5"
    });
  });

  it("does not prefer a 1M Opus variant over a plain default", () => {
    const defaults = computeAnthropicDefaults([
      "claude-opus-4.7",
      "claude-opus-4.7-1m-internal[1m]",
      "claude-sonnet-4.6"
    ]);
    expect(defaults.opus).toBe("claude-opus-4.7");
  });

  it("returns null for families that have no models", () => {
    const defaults = computeAnthropicDefaults(["claude-opus-4.7", "gpt-5"]);
    expect(defaults.opus).toBe("claude-opus-4.7");
    expect(defaults.sonnet).toBeNull();
    expect(defaults.haiku).toBeNull();
  });

  it("falls back to suffixed variants when all are suffixed", () => {
    const defaults = computeAnthropicDefaults(["claude-opus-4.7-high", "claude-opus-4.7-xhigh"]);
    expect(defaults.opus).toBe("claude-opus-4.7-xhigh");
  });

  it("handles snapshot-dated Anthropic ids", () => {
    const defaults = computeAnthropicDefaults([
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-sonnet-4-5-20250929",
      "claude-3-5-haiku-20241022"
    ]);
    expect(defaults.opus).toBe("claude-opus-4-1-20250805");
    expect(defaults.sonnet).toBe("claude-sonnet-4-5-20250929");
    expect(defaults.haiku).toBe("claude-3-5-haiku-20241022");
  });

  it("ignores non-claude prefixes", () => {
    const defaults = computeAnthropicDefaults(["gpt-opus", "gpt-sonnet", "gpt-haiku"]);
    expect(defaults).toEqual({ opus: null, sonnet: null, haiku: null });
  });
});

describe("anthropicDefaults.buildClaudeExportCommand", () => {
  it("emits all three default env vars when present", () => {
    const cmd = buildClaudeExportCommand({
      port: 4141,
      callerSecret: null,
      defaults: { opus: "claude-opus-4.7", sonnet: "claude-sonnet-4.6", haiku: "claude-haiku-4.5" },
      enableGatewayDiscovery: true
    });
    expect(cmd).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:4141/anthropic");
    expect(cmd).toContain("ANTHROPIC_AUTH_TOKEN=copillm-local");
    expect(cmd).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4.7");
    expect(cmd).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4.6");
    expect(cmd).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4.5");
    expect(cmd).toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1");
    expect(cmd.endsWith(" claude")).toBe(true);
  });

  it("omits default env vars when null", () => {
    const cmd = buildClaudeExportCommand({
      port: 4242,
      callerSecret: "abc",
      defaults: { opus: "claude-opus-4.7", sonnet: null, haiku: null },
      enableGatewayDiscovery: false
    });
    expect(cmd).toContain("ANTHROPIC_AUTH_TOKEN=abc");
    expect(cmd).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4.7");
    expect(cmd).not.toContain("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(cmd).not.toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(cmd).not.toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
  });
});

describe("anthropicDefaults.ANTHROPIC_FAMILIES", () => {
  it("enumerates opus sonnet haiku", () => {
    expect(ANTHROPIC_FAMILIES).toEqual(["opus", "sonnet", "haiku"]);
  });
});
