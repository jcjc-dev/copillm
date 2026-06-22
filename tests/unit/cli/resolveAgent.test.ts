import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidPinSpecError, parsePinSpec, packageNameFor, binNameFor } from "../../../src/cli/resolveAgent.js";

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

  it("parses scoped <pkg>@<ver> form (CLI source) when pkg matches the official package", () => {
    expect(parsePinSpec("codex", "@openai/codex@1.4.7")).toEqual({
      packageName: "@openai/codex",
      version: "1.4.7"
    });
    expect(parsePinSpec("claude", "@anthropic-ai/claude-code@2.0.0")).toEqual({
      packageName: "@anthropic-ai/claude-code",
      version: "2.0.0"
    });
  });

  /**
   * Audit finding (high): the old parser accepted `<arbitrary-pkg>@<ver>`
   * verbatim and ran `npm install` against it. A `.envrc` could carry
   * `COPILLM_CLAUDE_VERSION='evil-pkg@1.0.0'` and silently install code from
   * a malicious package on the next `copillm claude` run. The new parser:
   *   • for source="env" (the .envrc/CI path), accepts ONLY a bare version
   *   • for source="cli" (--copillm-use), accepts `<official-pkg>@<ver>` only
   * Either form refuses an arbitrary package name.
   */
  it("REFUSES an unscoped <pkg>@<ver> that doesn't match the official package (CLI)", () => {
    expect(() => parsePinSpec("codex", "codex@1.0.0", "cli")).toThrow(InvalidPinSpecError);
    expect(() => parsePinSpec("codex", "evil-pkg@1.0.0", "cli")).toThrow(InvalidPinSpecError);
  });

  it("REFUSES a scoped <pkg>@<ver> that doesn't match the official package (CLI)", () => {
    expect(() => parsePinSpec("claude", "@evil/codex@1.0.0", "cli")).toThrow(InvalidPinSpecError);
    expect(() => parsePinSpec("claude", "@openai/codex@1.0.0", "cli")).toThrow(InvalidPinSpecError);
  });

  it("REFUSES any <pkg>@<ver> at all when source=env (only bare versions allowed)", () => {
    expect(() => parsePinSpec("claude", "@anthropic-ai/claude-code@2.0.0", "env")).toThrow(
      InvalidPinSpecError
    );
    expect(() => parsePinSpec("claude", "evil-pkg@1.0.0", "env")).toThrow(InvalidPinSpecError);
    // But a bare version still works under env.
    expect(parsePinSpec("claude", "2.0.0", "env")).toEqual({
      packageName: "@anthropic-ai/claude-code",
      version: "2.0.0"
    });
  });

  it("REFUSES a version containing shell metacharacters (env or CLI)", () => {
    // Even if a `cli` caller forgot to validate, the shell-metachar gate must
    // catch '1.0.0 & echo PWNED' before it ever reaches spawnSync.
    expect(() => parsePinSpec("claude", "1.0.0 & echo PWNED", "env")).toThrow(InvalidPinSpecError);
    expect(() => parsePinSpec("claude", "@anthropic-ai/claude-code@1.0.0; rm -rf /", "cli")).toThrow(
      InvalidPinSpecError
    );
    expect(() => parsePinSpec("claude", "1.0.0|whoami", "cli")).toThrow(InvalidPinSpecError);
  });

  it("treats a bare scoped package (no version separator) as package-only when it matches the official pkg", () => {
    // `lastIndexOf("@")` returns 0 for `@scope/pkg`, and the `lastAt > 0` guard
    // must skip splitting in that case. The bare-pkg-only path now also gates
    // on the official-package check, so an attempt to pass a foreign scoped
    // package by itself is rejected.
    expect(parsePinSpec("codex", "@openai/codex")).toEqual({
      packageName: "@openai/codex",
      version: null
    });
    expect(parsePinSpec("claude", "@anthropic-ai/claude-code")).toEqual({
      packageName: "@anthropic-ai/claude-code",
      version: null
    });
  });

  it("REFUSES a bare scoped package whose name doesn't match the official pkg", () => {
    expect(() => parsePinSpec("claude", "@evil-scope/evil-pkg", "cli")).toThrow(InvalidPinSpecError);
  });

  it("REFUSES an unscoped package name with no @ at all (was permissive in the old parser)", () => {
    // The OLD parser returned `{packageName: "evil-pkg", version: null}` here,
    // which let an env-supplied "evil-pkg" install verbatim. New parser
    // refuses anything that isn't a bare version OR the official package.
    expect(() => parsePinSpec("codex", "evil-pkg")).toThrow(InvalidPinSpecError);
    expect(() => parsePinSpec("codex", "evil-pkg", "env")).toThrow(InvalidPinSpecError);
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

/**
 * Audit finding (high): the install path used to call
 * `spawnSync(..., { shell: process.platform === 'win32' })` and pass the npm
 * spec WITHOUT `--ignore-scripts`. Two failure modes:
 *   • Windows shell-injection via attacker-influenced version strings
 *     (caught by `parsePinSpec` above, but defence-in-depth still matters).
 *   • A tampered package's preinstall/postinstall script runs as the user
 *     before the bin smoke-test catches the unusable package.
 *
 * The runtime fix in `src/cli/resolveAgent.ts`:
 *   • spawns npm without `shell: true` (Windows routes through cmd.exe with
 *     safe quoting via `windowsSpawn`'s buildWindowsCmdInvocation)
 *   • passes `--ignore-scripts` to npm install
 *
 * We exercise the install code path with a fake npm shim that records its
 * argv into a file so we can assert the args without depending on real npm.
 */
describe("resolveAgent (install args)", async () => {
  const { resolveAgent } = await import("../../../src/cli/resolveAgent.js");

  /**
   * Fake npm that records its full argv to <tmp>/npm-argv.json and EXITS 0
   * for `view`/`install`. For `install`, it also stages the cache layout the
   * resolver expects so the smoke-test passes.
   */
  function recordingNpm(dir: string, argvPath: string): string {
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") {
      // Minimal Node-backed shim — record argv, then mimic a successful npm
      // install by creating the bin under --prefix.
      const jsPath = path.join(dir, "fake-npm-impl.js");
      fs.writeFileSync(
        jsPath,
        `const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv) + "\\n");
if (argv[0] === 'install') {
  const prefixIdx = argv.indexOf('--prefix');
  const prefix = argv[prefixIdx + 1];
  const binDir = path.join(prefix, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'codex.cmd');
  fs.writeFileSync(binPath, '@echo 0.0.1\\r\\n');
}
if (argv[0] === 'view') process.stdout.write('1.2.3\\n');
process.exit(0);
`
      );
      const cmdPath = path.join(dir, "fake-npm.cmd");
      fs.writeFileSync(cmdPath, `@node "${jsPath}" %*\r\n`);
      return cmdPath;
    }
    const shPath = path.join(dir, "fake-npm");
    fs.writeFileSync(
      shPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv) + "\\n");
if (argv[0] === 'install') {
  const prefixIdx = argv.indexOf('--prefix');
  const prefix = argv[prefixIdx + 1];
  const binDir = path.join(prefix, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'codex');
  fs.writeFileSync(binPath, '#!/bin/sh\\necho 0.0.1\\n', { mode: 0o755 });
}
if (argv[0] === 'view') process.stdout.write('1.2.3\\n');
process.exit(0);
`,
      { mode: 0o755 }
    );
    return shPath;
  }

  it("passes --ignore-scripts to npm install", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-install-argv-"));
    try {
      const argvLog = path.join(tmp, "npm-argv.jsonl");
      const npmExe = recordingNpm(path.join(tmp, "fakenpm"), argvLog);
      const cacheRoot = path.join(tmp, "cache");

      await resolveAgent("codex", { cacheRoot, npmExecutable: npmExe });

      const recorded = fs
        .readFileSync(argvLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const installCall = recorded.find((argv) => argv[0] === "install");
      expect(installCall, `expected an install call. Got: ${JSON.stringify(recorded)}`).toBeDefined();
      expect(installCall).toContain("--ignore-scripts");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses the canonical install args (prefix + no-audit + no-fund + omit=dev + ignore-scripts + spec)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-install-args-canonical-"));
    try {
      const argvLog = path.join(tmp, "npm-argv.jsonl");
      const npmExe = recordingNpm(path.join(tmp, "fakenpm"), argvLog);
      const cacheRoot = path.join(tmp, "cache");

      await resolveAgent("codex", { cacheRoot, npmExecutable: npmExe });

      const recorded = fs
        .readFileSync(argvLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const installCall = recorded.find((argv) => argv[0] === "install")!;
      // Must contain each safety flag exactly once.
      expect(installCall.filter((a) => a === "--no-audit")).toHaveLength(1);
      expect(installCall.filter((a) => a === "--no-fund")).toHaveLength(1);
      expect(installCall.filter((a) => a === "--omit=dev")).toHaveLength(1);
      expect(installCall.filter((a) => a === "--ignore-scripts")).toHaveLength(1);
      // The spec must end with @<version> (the fake npm view returned "1.2.3").
      const spec = installCall[installCall.length - 1];
      expect(spec).toBe("@openai/codex@1.2.3");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
