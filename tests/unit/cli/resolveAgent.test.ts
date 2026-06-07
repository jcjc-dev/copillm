import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePinSpec, packageNameFor, binNameFor } from "../../../src/cli/resolveAgent.js";

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
  it("maps codex/claude/pi/copilot to upstream npm packages and bin names", () => {
    expect(packageNameFor("codex")).toBe("@openai/codex");
    expect(packageNameFor("claude")).toBe("@anthropic-ai/claude-code");
    expect(packageNameFor("pi")).toBe("@earendil-works/pi-coding-agent");
    expect(packageNameFor("copilot")).toBe("@github/copilot");
    expect(binNameFor("codex")).toBe("codex");
    expect(binNameFor("claude")).toBe("claude");
    expect(binNameFor("pi")).toBe("pi");
    expect(binNameFor("copilot")).toBe("copilot");
  });
});

describe("resolveAgent (path lookup)", async () => {
  const { resolveAgent } = await import("../../../src/cli/resolveAgent.js");

  it("returns source=path when binary exists on PATH and preferPath is opted in", async () => {
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

        const result = await resolveAgent("codex", { cacheRoot, preferPath: true });
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

  it("ignores binary on PATH by default and prefers the cached version", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-resolve-"));
    try {
      const binDir = path.join(tmp, "bin");
      fs.mkdirSync(binDir, { recursive: true });

      // Stage a fake "codex" on PATH that, if used, would resolve as source=path.
      if (process.platform === "win32") {
        const jsPath = path.join(binDir, "codex.js");
        fs.writeFileSync(jsPath, `#!/usr/bin/env node\nconsole.log("0.0.1");\nprocess.exit(0);\n`);
        fs.writeFileSync(path.join(binDir, "codex.cmd"), `@node "${jsPath}" %*\r\n`);
      } else {
        fs.writeFileSync(path.join(binDir, "codex"), `#!/bin/sh\necho 0.0.1\n`, { mode: 0o755 });
      }

      // Pre-populate the cache with a fake installed codex so the resolver picks it
      // up via the "cached fallback" branch (no version pin, no network).
      // The cache hit requires BOTH the bin and the version.txt marker —
      // see findReadyCachedBin in src/cli/resolveAgent.ts.
      const cacheRoot = path.join(tmp, "cache");
      const cachedVersionDir = path.join(cacheRoot, "codex", "9.9.9");
      const cachedBinDir = path.join(cachedVersionDir, "node_modules", ".bin");
      fs.mkdirSync(cachedBinDir, { recursive: true });
      const cachedBinName = process.platform === "win32" ? "codex.cmd" : "codex";
      const cachedBinPath = path.join(cachedBinDir, cachedBinName);
      if (process.platform === "win32") {
        fs.writeFileSync(cachedBinPath, `@echo 9.9.9\r\n`);
      } else {
        fs.writeFileSync(cachedBinPath, `#!/bin/sh\necho 9.9.9\n`, { mode: 0o755 });
      }
      fs.writeFileSync(path.join(cachedVersionDir, "version.txt"), "9.9.9\n");

      const prevPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
      try {
        // No preferPath / offline → PATH must be ignored, cache must win.
        const result = await resolveAgent("codex", { cacheRoot, offline: true });
        expect(result.source).toBe("cache");
        expect(result.binPath).toBe(cachedBinPath);
        expect(result.displayLine).not.toContain("system PATH");
      } finally {
        process.env.PATH = prevPath;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Cache-readiness gate: version.txt is the install-complete marker. If it's
// missing (= the previous install was interrupted before the smoke test wrote
// it), the directory MUST NOT be treated as a cache hit even though the bin
// exists.
describe("resolveAgent (cache readiness)", async () => {
  const { resolveAgent } = await import("../../../src/cli/resolveAgent.js");

  function seedCachedBin(cacheRoot: string, agent: string, version: string, opts: { withMarker: boolean }): string {
    const versionDir = path.join(cacheRoot, agent, version);
    const binDir = path.join(versionDir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binName = process.platform === "win32" ? `${agent}.cmd` : agent;
    const binPath = path.join(binDir, binName);
    if (process.platform === "win32") {
      fs.writeFileSync(binPath, `@echo ${version}\r\n`);
    } else {
      fs.writeFileSync(binPath, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    }
    if (opts.withMarker) {
      fs.writeFileSync(path.join(versionDir, "version.txt"), `${version}\n`);
    }
    return binPath;
  }

  it("hits the cache when both bin and version.txt are present", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-resolve-ready-"));
    try {
      const cacheRoot = path.join(tmp, "cache");
      const expectedBin = seedCachedBin(cacheRoot, "codex", "1.2.3", { withMarker: true });
      const result = await resolveAgent("codex", { cacheRoot, offline: true });
      expect(result.source).toBe("cache");
      expect(result.binPath).toBe(expectedBin);
      expect(result.version).toBe("1.2.3");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("misses the cache when version.txt is absent (partial install)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-resolve-partial-"));
    try {
      const cacheRoot = path.join(tmp, "cache");
      seedCachedBin(cacheRoot, "codex", "1.2.3", { withMarker: false });
      // Offline mode + no marker = no installable fallback = error.
      // The bin existing alone must NOT be enough to consider the cache ready.
      await expect(resolveAgent("codex", { cacheRoot, offline: true })).rejects.toThrow(
        /not installed/
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pickLastCached skips partial installs and picks the newest marker-complete one", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-resolve-skip-partial-"));
    try {
      const cacheRoot = path.join(tmp, "cache");
      // 2.0.0 is partial (no marker), 1.5.0 is complete. Even though 2.0.0
      // sorts higher, fallback must pick 1.5.0.
      seedCachedBin(cacheRoot, "codex", "2.0.0", { withMarker: false });
      const expected = seedCachedBin(cacheRoot, "codex", "1.5.0", { withMarker: true });
      const result = await resolveAgent("codex", { cacheRoot, offline: true });
      expect(result.source).toBe("cache");
      expect(result.binPath).toBe(expected);
      expect(result.version).toBe("1.5.0");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Registry-unreachable fallback: if `npm view <pkg> version` fails (network
// down, corp proxy, npm outage), copillm must transparently fall back to the
// newest version it has on disk instead of erroring out — the user can keep
// working with whatever they last successfully installed.
describe("resolveAgent (npm view fallback)", async () => {
  const { resolveAgent } = await import("../../../src/cli/resolveAgent.js");

  function fakeNpmThatAlwaysFails(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") {
      const cmdPath = path.join(dir, "fake-npm.cmd");
      // @echo off + write to stderr + exit nonzero, to mimic `npm view` failing.
      fs.writeFileSync(cmdPath, "@echo off\r\necho fake-npm: network unreachable 1>&2\r\nexit /b 1\r\n");
      return cmdPath;
    }
    const shPath = path.join(dir, "fake-npm");
    fs.writeFileSync(shPath, "#!/bin/sh\necho 'fake-npm: network unreachable' 1>&2\nexit 1\n", { mode: 0o755 });
    return shPath;
  }

  function seedCachedBin(cacheRoot: string, agent: string, version: string): string {
    const versionDir = path.join(cacheRoot, agent, version);
    const binDir = path.join(versionDir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binName = process.platform === "win32" ? `${agent}.cmd` : agent;
    const binPath = path.join(binDir, binName);
    if (process.platform === "win32") {
      fs.writeFileSync(binPath, `@echo ${version}\r\n`);
    } else {
      fs.writeFileSync(binPath, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(versionDir, "version.txt"), `${version}\n`);
    return binPath;
  }

  it("falls back to the latest cached version when npm view fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-resolve-npm-fail-"));
    try {
      const cacheRoot = path.join(tmp, "cache");
      const expectedBin = seedCachedBin(cacheRoot, "codex", "1.2.3");
      const npmExecutable = fakeNpmThatAlwaysFails(path.join(tmp, "fakenpm"));

      const logs: string[] = [];
      const result = await resolveAgent("codex", {
        cacheRoot,
        npmExecutable,
        log: (line) => logs.push(line)
      });

      expect(result.source).toBe("cache");
      expect(result.binPath).toBe(expectedBin);
      expect(result.version).toBe("1.2.3");
      // The fallback should warn the user that the registry was unreachable so
      // they know they're not necessarily running the latest version.
      const warned = logs.some((l) => /npm registry/i.test(l) && /codex/.test(l) && /1\.2\.3/.test(l));
      expect(warned, `expected a registry-unreachable warning in logs: ${JSON.stringify(logs)}`).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("errors with a clear message when npm view fails AND the cache is empty", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-resolve-no-cache-"));
    try {
      const cacheRoot = path.join(tmp, "cache");
      const npmExecutable = fakeNpmThatAlwaysFails(path.join(tmp, "fakenpm"));

      await expect(
        resolveAgent("codex", { cacheRoot, npmExecutable })
      ).rejects.toThrow(/could not reach npm registry/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
