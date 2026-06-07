import { describe, expect, it } from "vitest";
import { buildWindowsCmdInvocation } from "../../../src/cli/windowsSpawn.js";

// Mirrors the well-known cross-spawn quoting behaviour. The point of these
// tests is to lock the algorithm in place so a future "small refactor" can't
// silently regress shell-injection safety on Windows.
describe("buildWindowsCmdInvocation", () => {
  it("returns a /d /s /c cmd.exe invocation", () => {
    const { command, args } = buildWindowsCmdInvocation("C:\\path\\copilot.cmd", []);
    expect(command.toLowerCase()).toContain("cmd.exe");
    expect(args[0]).toBe("/d");
    expect(args[1]).toBe("/s");
    expect(args[2]).toBe("/c");
    expect(args).toHaveLength(4);
  });

  it("wraps the entire command line in a single outer-quoted argument", () => {
    const { args } = buildWindowsCmdInvocation("copilot.cmd", ["hello"]);
    const payload = args[3];
    expect(payload.startsWith('"')).toBe(true);
    expect(payload.endsWith('"')).toBe(true);
  });

  it("escapes spaces with caret so cmd.exe doesn't split the argument", () => {
    const { args } = buildWindowsCmdInvocation("copilot.cmd", ["hello world"]);
    // Double-escape pass: the inner quoting "hello world" becomes
    // ^^^"hello^^^ world^^^" so each metachar (quote, space) survives the
    // outer-shim → inner-shim chain.
    expect(args[3]).toContain("^^^\"hello^^^ world^^^\"");
  });

  it("escapes embedded double quotes using the backslash-quote dance", () => {
    const { args } = buildWindowsCmdInvocation("copilot.cmd", ['say "hi"']);
    // The user's " gets backslash-escaped (\") before the caret-doubling pass.
    expect(args[3]).toContain('\\^^^"hi\\^^^"');
  });

  it("escapes cmd.exe metacharacters with caret to block shell injection", () => {
    const { args } = buildWindowsCmdInvocation("copilot.cmd", ["a&b"]);
    // We double-escape by default for npm-style shims, so & becomes ^^&
    // (the outer cmd.exe peels one layer, the shim's nested cmd.exe peels the
    // other, leaving a literal & for the underlying program).
    expect(args[3]).toContain("^^&");
    expect(args[3]).not.toMatch(/[^^]&[^^]/);
  });

  it("escapes pipe, redirect, and grouping characters", () => {
    const { args } = buildWindowsCmdInvocation(
      "copilot.cmd",
      ["a|b", "c<d", "e>f", "(g)"]
    );
    const payload = args[3];
    expect(payload).toContain("^^|");
    expect(payload).toContain("^^<");
    expect(payload).toContain("^^>");
    expect(payload).toContain("^^(");
    expect(payload).toContain("^^)");
  });

  it("escapes the executable path's metacharacters too", () => {
    // Hypothetical install path with parentheses (e.g. "Program Files (x86)").
    const { args } = buildWindowsCmdInvocation(
      "C:\\Program Files (x86)\\node\\copilot.cmd",
      []
    );
    expect(args[3]).toContain("^(x86^)");
  });

  it("preserves backslashes that are not followed by a quote", () => {
    const { args } = buildWindowsCmdInvocation(
      "copilot.cmd",
      ["C:\\Users\\me\\file.txt"]
    );
    expect(args[3]).toContain("C:\\Users\\me\\file.txt");
  });

  it("doubles trailing backslashes so the closing quote is not escaped", () => {
    const { args } = buildWindowsCmdInvocation("copilot.cmd", ["dir\\"]);
    // Without doubling, the closing " would be eaten by the trailing \,
    // breaking CommandLineToArgvW parsing on the receiving side.
    // After double-escape, the closing quote becomes ^^^" (preceded by \\).
    expect(args[3]).toContain('dir\\\\^^^"');
  });

  it("honours ComSpec env var when present", () => {
    const original = process.env.ComSpec;
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    try {
      const { command } = buildWindowsCmdInvocation("copilot.cmd", []);
      expect(command).toBe("C:\\Windows\\System32\\cmd.exe");
    } finally {
      if (original === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = original;
      }
    }
  });

  it("falls back to bare cmd.exe when ComSpec is not set", () => {
    const original = process.env.ComSpec;
    const originalLower = process.env.comspec;
    delete process.env.ComSpec;
    delete process.env.comspec;
    try {
      const { command } = buildWindowsCmdInvocation("copilot.cmd", []);
      expect(command).toBe("cmd.exe");
    } finally {
      if (original !== undefined) process.env.ComSpec = original;
      if (originalLower !== undefined) process.env.comspec = originalLower;
    }
  });

  it("supports turning off double-escape for non-shim targets", () => {
    const { args } = buildWindowsCmdInvocation("real.cmd", ["a&b"], false);
    // Single-escape mode: & becomes ^& (one layer only).
    expect(args[3]).toContain("^&");
    expect(args[3]).not.toContain("^^&");
  });
});
