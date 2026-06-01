import { describe, expect, it, vi } from "vitest";
import { applyYolo, resolveYolo, resolveYoloWithSource, yoloFromEnv, AGENTS } from "../../../src/agents/registry.js";

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

  it("includes the source label in the unsupported-agent warning", () => {
    const warn = vi.fn();
    applyYolo({ agent: "pi", userArgs: [], yolo: true, source: "profile.enabled", warn });
    expect(warn.mock.calls[0][0]).toMatch(/source: profile enabled/);
  });

  it("does not mutate the input array", () => {
    const input = ["chat"];
    applyYolo({ agent: "claude", userArgs: input, yolo: true });
    expect(input).toEqual(["chat"]);
  });
});

describe("yoloFromEnv (tri-state)", () => {
  it("returns undefined when unset or empty", () => {
    expect(yoloFromEnv({})).toBeUndefined();
    expect(yoloFromEnv({ COPILLM_YOLO: "" })).toBeUndefined();
  });

  it.each(["1", "true", "yes", "TRUE", " Yes "])("treats %j as explicit true", (value) => {
    expect(yoloFromEnv({ COPILLM_YOLO: value })).toBe(true);
  });

  it.each(["0", "false", "no", "FALSE", " No "])("treats %j as explicit false", (value) => {
    expect(yoloFromEnv({ COPILLM_YOLO: value })).toBe(false);
  });

  it("returns undefined for unrecognised values (no opinion)", () => {
    expect(yoloFromEnv({ COPILLM_YOLO: "maybe" })).toBeUndefined();
  });
});

describe("resolveYolo (legacy wrapper)", () => {
  it("returns true when the flag is set, regardless of env", () => {
    expect(resolveYolo(true, {})).toBe(true);
  });

  it("falls back to the env var when the flag is undefined", () => {
    expect(resolveYolo(undefined, { COPILLM_YOLO: "1" })).toBe(true);
    expect(resolveYolo(undefined, {})).toBe(false);
  });

  it("treats explicit off env as false even without a flag", () => {
    expect(resolveYolo(undefined, { COPILLM_YOLO: "0" })).toBe(false);
  });
});

describe("resolveYoloWithSource precedence", () => {
  const profile = {
    yolo: { enabled: true, agents: { claude: false } },
    profileName: "work"
  };

  it("flag wins over everything (env=off, profile says false for claude)", () => {
    const r = resolveYoloWithSource({
      agent: "claude",
      flag: true,
      env: { COPILLM_YOLO: "0" },
      profile
    });
    expect(r).toMatchObject({ value: true, source: "flag" });
  });

  it("env (truthy) wins over profile when no flag", () => {
    const r = resolveYoloWithSource({
      agent: "claude",
      env: { COPILLM_YOLO: "1" },
      profile
    });
    expect(r).toMatchObject({ value: true, source: "env" });
  });

  it("env (explicit off) vetoes profile when no flag", () => {
    const r = resolveYoloWithSource({
      agent: "codex",
      env: { COPILLM_YOLO: "0" },
      profile
    });
    expect(r).toMatchObject({ value: false, source: "env" });
  });

  it("profile.agents overrides profile.enabled per-agent", () => {
    const r = resolveYoloWithSource({ agent: "claude", env: {}, profile });
    expect(r).toMatchObject({ value: false, source: "profile.agents" });
    expect(r.label).toMatch(/profile "work"/);
  });

  it("falls through to profile.enabled when no per-agent override", () => {
    const r = resolveYoloWithSource({ agent: "codex", env: {}, profile });
    expect(r).toMatchObject({ value: true, source: "profile.enabled" });
  });

  it("returns off when nothing is configured", () => {
    const r = resolveYoloWithSource({ agent: "claude", env: {} });
    expect(r).toMatchObject({ value: false, source: "off" });
  });

  it("handles null profile (no agent.toml loaded)", () => {
    const r = resolveYoloWithSource({ agent: "claude", env: {}, profile: null });
    expect(r).toMatchObject({ value: false, source: "off" });
  });
});

describe("AGENTS registry shape", () => {
  it("covers all four known agents", () => {
    expect(Object.keys(AGENTS).sort()).toEqual(["claude", "codex", "copilot", "pi"]);
  });
});
