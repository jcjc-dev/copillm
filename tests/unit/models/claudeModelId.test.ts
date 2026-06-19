import { describe, expect, it } from "vitest";
import {
  toAnthropicSurfaceModelId,
  toUpstreamModelId
} from "../../../src/models/claudeModelId.js";

describe("claudeModelId.toAnthropicSurfaceModelId", () => {
  it("dashes the trailing dotted version of a claude id", () => {
    expect(toAnthropicSurfaceModelId("claude-sonnet-4.6")).toBe("claude-sonnet-4-6");
    expect(toAnthropicSurfaceModelId("claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(toAnthropicSurfaceModelId("claude-haiku-4.5")).toBe("claude-haiku-4-5");
  });

  it("supports multi-digit minor versions", () => {
    expect(toAnthropicSurfaceModelId("claude-sonnet-4.10")).toBe("claude-sonnet-4-10");
  });

  it("leaves non-claude ids untouched (gpt / gemini carry mid-string dots)", () => {
    expect(toAnthropicSurfaceModelId("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(toAnthropicSurfaceModelId("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(toAnthropicSurfaceModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  it("leaves claude ids without a trailing dotted version untouched", () => {
    expect(toAnthropicSurfaceModelId("claude-opus-4-1-20250805")).toBe("claude-opus-4-1-20250805");
    expect(toAnthropicSurfaceModelId("claude-opus-4.7-xhigh")).toBe("claude-opus-4.7-xhigh");
    expect(toAnthropicSurfaceModelId("claude-3-5-haiku")).toBe("claude-3-5-haiku");
  });
});

describe("claudeModelId.toUpstreamModelId", () => {
  it("restores the trailing dotted version of a claude id", () => {
    expect(toUpstreamModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4.6");
    expect(toUpstreamModelId("claude-opus-4-8")).toBe("claude-opus-4.8");
    expect(toUpstreamModelId("claude-haiku-4-5")).toBe("claude-haiku-4.5");
  });

  it("passes an already-dotted claude id through unchanged", () => {
    expect(toUpstreamModelId("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
  });

  it("leaves non-claude ids untouched", () => {
    expect(toUpstreamModelId("gpt-5.4")).toBe("gpt-5.4");
    expect(toUpstreamModelId("gpt-test")).toBe("gpt-test");
  });
});

describe("claudeModelId round-trip", () => {
  it("is an exact inverse for every Copilot claude catalog id", () => {
    const upstreamIds = [
      "claude-opus-4.5",
      "claude-opus-4.6",
      "claude-opus-4.7",
      "claude-opus-4.8",
      "claude-sonnet-4.5",
      "claude-sonnet-4.6",
      "claude-haiku-4.5"
    ];
    for (const id of upstreamIds) {
      expect(toUpstreamModelId(toAnthropicSurfaceModelId(id))).toBe(id);
    }
  });
});
