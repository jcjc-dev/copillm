import { describe, expect, it, vi } from "vitest";
import { applyYolo, resolveYolo, yoloFromEnv, AGENTS } from "../src/agents/registry.js";

describe("applyYolo", () => {
  it("returns userArgs unchanged when yolo=false", () => {
    const args = applyYolo({ agent: "claude", userArgs: ["--foo"], yolo: false });
    expect(args).toEqual(["--foo"]);
  });

  it("injects the configured flag(s) for claude", () => {
    const args = applyYolo({ agent: "claude", userArgs: ["chat"], yolo: true });
    expect(args).toEqual(["--dangerously-skip-permissions", "chat"]);
  });

  it("injects the long alias for codex", () => {
    const args = applyYolo({ agent: "codex", userArgs: [], yolo: true });
    expect(args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("injects --allow-all for copilot", () => {
    const args = applyYolo({ agent: "copilot", userArgs: ["-p", "hi"], yolo: true });
    expect(args).toEqual(["--allow-all", "-p", "hi"]);
  });

  it("skips injection when the native flag is already in userArgs (no double-add)", () => {
    const args = applyYolo({
      agent: "claude",
      userArgs: ["--dangerously-skip-permissions", "chat"],
      yolo: true
    });
    expect(args).toEqual(["--dangerously-skip-permissions", "chat"]);
  });

  it("warns and forwards unchanged for unsupported agents (pi)", () => {
    const warn = vi.fn();
    const args = applyYolo({ agent: "pi", userArgs: ["foo"], yolo: true, warn });
    expect(args).toEqual(["foo"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/--yolo ignored for pi/);
  });

  it("does not mutate the input array", () => {
    const input = ["chat"];
    applyYolo({ agent: "claude", userArgs: input, yolo: true });
    expect(input).toEqual(["chat"]);
  });
});

describe("yoloFromEnv", () => {
  it("returns false when unset", () => {
    expect(yoloFromEnv({})).toBe(false);
  });

  it.each(["1", "true", "yes", "TRUE", " Yes "])("treats %j as truthy", (value) => {
    expect(yoloFromEnv({ COPILLM_YOLO: value })).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("treats %j as falsy", (value) => {
    expect(yoloFromEnv({ COPILLM_YOLO: value })).toBe(false);
  });
});

describe("resolveYolo", () => {
  it("returns true when the flag is set, regardless of env", () => {
    expect(resolveYolo(true, {})).toBe(true);
  });

  it("falls back to the env var when the flag is undefined", () => {
    expect(resolveYolo(undefined, { COPILLM_YOLO: "1" })).toBe(true);
    expect(resolveYolo(undefined, {})).toBe(false);
  });
});

describe("AGENTS registry shape", () => {
  it("covers all four known agents", () => {
    expect(Object.keys(AGENTS).sort()).toEqual(["claude", "codex", "copilot", "pi"]);
  });
});
