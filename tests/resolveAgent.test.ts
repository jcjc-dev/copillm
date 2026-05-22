import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePinSpec, packageNameFor, binNameFor } from "../src/cli/resolveAgent.js";

describe("parsePinSpec", () => {
  it("returns default package + null version for empty input", () => {
    expect(parsePinSpec("codex", "")).toEqual({ packageName: "@openai/codex", version: null });
    expect(parsePinSpec("pi", "")).toEqual({ packageName: "@earendil-works/pi-coding-agent", version: null });
  });

  it("parses bare version into default package + version", () => {
    expect(parsePinSpec("codex", "1.4.7")).toEqual({ packageName: "@openai/codex", version: "1.4.7" });
    expect(parsePinSpec("claude", "^2.0.0")).toEqual({ packageName: "@anthropic-ai/claude-code", version: "^2.0.0" });
    expect(parsePinSpec("pi", "0.75.4")).toEqual({ packageName: "@earendil-works/pi-coding-agent", version: "0.75.4" });
  });

  it("parses scoped <pkg>@<ver> form", () => {
    expect(parsePinSpec("codex", "@openai/codex@1.4.7")).toEqual({
      packageName: "@openai/codex",
      version: "1.4.7"
    });
    expect(parsePinSpec("claude", "@anthropic-ai/claude-code@2.0.0")).toEqual({
      packageName: "@anthropic-ai/claude-code",
      version: "2.0.0"
    });
  });

  it("parses unscoped <pkg>@<ver>", () => {
    expect(parsePinSpec("codex", "codex@1.0.0")).toEqual({ packageName: "codex", version: "1.0.0" });
  });

  it("treats a bare scoped package (no version separator) as package-only", () => {
    // `lastIndexOf("@")` returns 0 for `@scope/pkg`, and the `lastAt > 0` guard
    // must skip splitting in that case. A regression here would split into
    // { packageName: "", version: "openai/codex" } and silently install nothing.
    expect(parsePinSpec("codex", "@openai/codex")).toEqual({
      packageName: "@openai/codex",
      version: null
    });
    expect(parsePinSpec("claude", "@anthropic-ai/claude-code")).toEqual({
      packageName: "@anthropic-ai/claude-code",
      version: null
    });
  });

  it("treats an unscoped package name (no @ at all) as package-only", () => {
    expect(parsePinSpec("codex", "codex")).toEqual({ packageName: "codex", version: null });
  });

  it("normalises surrounding whitespace before parsing", () => {
    expect(parsePinSpec("codex", "  1.4.7  ")).toEqual({
      packageName: "@openai/codex",
      version: "1.4.7"
    });
    expect(parsePinSpec("codex", "  @openai/codex@1.4.7  ")).toEqual({
      packageName: "@openai/codex",
      version: "1.4.7"
    });
  });
});

describe("packageNameFor / binNameFor", () => {
  it("maps codex/claude/pi to upstream npm packages and bin names", () => {
    expect(packageNameFor("codex")).toBe("@openai/codex");
    expect(packageNameFor("claude")).toBe("@anthropic-ai/claude-code");
    expect(packageNameFor("pi")).toBe("@earendil-works/pi-coding-agent");
    expect(binNameFor("codex")).toBe("codex");
    expect(binNameFor("claude")).toBe("claude");
    expect(binNameFor("pi")).toBe("pi");
  });
});

describe("resolveAgent (path lookup)", async () => {
  const { resolveAgent } = await import("../src/cli/resolveAgent.js");

  it("returns source=path when binary exists on PATH", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-resolve-"));
    try {
      const binDir = path.join(tmp, "bin");
      fs.mkdirSync(binDir, { recursive: true });

      // Cross-platform stub: a Node script + .cmd shim on Windows.
      if (process.platform === "win32") {
        const jsPath = path.join(binDir, "fakecmd.js");
        fs.writeFileSync(jsPath, `#!/usr/bin/env node\nconsole.log("0.0.1");\nprocess.exit(0);\n`);
        const cmdPath = path.join(binDir, "fakecmd.cmd");
        fs.writeFileSync(cmdPath, `@node "${jsPath}" %*\r\n`);
      } else {
        const shimPath = path.join(binDir, "fakecmd");
        fs.writeFileSync(shimPath, `#!/bin/sh\necho 0.0.1\n`, { mode: 0o755 });
      }

      const cacheRoot = path.join(tmp, "cache");
      const prevPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
      try {
        // Resolve "codex" but our stub is named "fakecmd", so PATH lookup must miss.
        // We use a private re-mapping by temporarily renaming the stub to "codex".
        const altName = process.platform === "win32" ? "codex.cmd" : "codex";
        const altSrc = process.platform === "win32"
          ? path.join(binDir, "fakecmd.cmd")
          : path.join(binDir, "fakecmd");
        fs.renameSync(altSrc, path.join(binDir, altName));

        const result = await resolveAgent("codex", { cacheRoot });
        expect(result.source).toBe("path");
        expect(result.binPath).toContain(binDir);
        expect(result.displayLine).toContain("system PATH");
      } finally {
        process.env.PATH = prevPath;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
