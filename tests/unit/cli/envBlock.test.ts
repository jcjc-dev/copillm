import { describe, expect, it } from "vitest";
import { renderEnvBlock, renderEnvLine, isShellSyntax } from "../../../src/cli/envBlock.js";

describe("renderEnvLine", () => {
  it("renders sh export", () => {
    expect(renderEnvLine("FOO", "bar baz", "sh")).toBe('export FOO="bar baz"');
  });
  it("renders fish set -gx", () => {
    expect(renderEnvLine("FOO", "bar baz", "fish")).toBe('set -gx FOO "bar baz"');
  });
  it("renders powershell $env", () => {
    expect(renderEnvLine("FOO", "bar baz", "powershell")).toBe('$env:FOO = "bar baz"');
  });
  it("escapes $ in sh to prevent shell expansion", () => {
    expect(renderEnvLine("FOO", "$HOME/x", "sh")).toBe('export FOO="\\$HOME/x"');
  });
  it("escapes double quotes and backslashes in sh", () => {
    expect(renderEnvLine("FOO", 'a"b\\c', "sh")).toBe('export FOO="a\\"b\\\\c"');
  });
  it("escapes backticks in sh", () => {
    expect(renderEnvLine("FOO", "a`b", "sh")).toBe('export FOO="a\\`b"');
  });
  it("escapes $ in powershell with backtick", () => {
    expect(renderEnvLine("FOO", "$x", "powershell")).toBe('$env:FOO = "`$x"');
  });
});

describe("renderEnvBlock", () => {
  it("renders codex header + env", () => {
    const out = renderEnvBlock({
      agent: "codex",
      shell: "sh",
      env: { CODEX_HOME: "/Users/x/.copillm/codex" }
    });
    expect(out).toBe(
      `# Codex CLI \u2192 copillm\nexport CODEX_HOME="/Users/x/.copillm/codex"`
    );
  });
  it("renders claude header + multi-line block", () => {
    const out = renderEnvBlock({
      agent: "claude",
      shell: "sh",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4141/anthropic",
        ANTHROPIC_AUTH_TOKEN: "copillm-local"
      }
    });
    expect(out.split("\n")[0]).toBe(`# Claude Code \u2192 copillm`);
    expect(out).toContain('export ANTHROPIC_BASE_URL="http://127.0.0.1:4141/anthropic"');
  });
  it("appends inline comments after the var line", () => {
    const out = renderEnvBlock({
      agent: "codex",
      shell: "sh",
      env: { FOO: "bar" },
      inlineComments: { FOO: "explanation" }
    });
    expect(out).toContain('export FOO="bar"    # explanation');
  });
  it("appends trailing notes as # lines", () => {
    const out = renderEnvBlock({
      agent: "claude",
      shell: "sh",
      env: { ANTHROPIC_BASE_URL: "x" },
      trailingNotes: ["no opus variant detected"]
    });
    expect(out.endsWith("# no opus variant detected")).toBe(true);
  });
  it("renders fish syntax", () => {
    const out = renderEnvBlock({
      agent: "codex",
      shell: "fish",
      env: { CODEX_HOME: "/x" }
    });
    expect(out).toContain('set -gx CODEX_HOME "/x"');
  });
  it("renders powershell syntax", () => {
    const out = renderEnvBlock({
      agent: "codex",
      shell: "powershell",
      env: { CODEX_HOME: "C:\\x" }
    });
    expect(out).toContain('$env:CODEX_HOME = "C:\\x"');
  });
});

describe("isShellSyntax", () => {
  it("accepts the three valid values", () => {
    expect(isShellSyntax("sh")).toBe(true);
    expect(isShellSyntax("fish")).toBe(true);
    expect(isShellSyntax("powershell")).toBe(true);
  });
  it("rejects others", () => {
    expect(isShellSyntax("zsh")).toBe(false);
    expect(isShellSyntax("")).toBe(false);
  });
});
