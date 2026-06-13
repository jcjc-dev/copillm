import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type AgentName = "codex" | "claude" | "pi";

export interface AgentStubInfo {
  binDir: string;
  capturePath: string;
}

const STUB_VERSION = "0.0.1";

/**
 * Creates a fake `codex` or `claude` binary in `binDir` that records the
 * arguments and a curated subset of env vars to `capturePath` (JSON), then
 * exits 0. Cross-platform: writes a shell shim on POSIX, plus a `.cmd`
 * wrapper on Windows that delegates to a Node script.
 *
 * Returns the bin directory + path to the capture file.
 */
export function createAgentStub(opts: { dir: string; agent: AgentName; capturePath: string }): AgentStubInfo {
  const binDir = path.join(opts.dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeNodeShim(binDir);

  const interestingEnvVars =
    opts.agent === "codex"
      ? ["CODEX_HOME"]
      : opts.agent === "pi"
      ? ["HOME", "PI_CODING_AGENT_DIR"]
      : [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
        ];

  const jsScript =
    `#!/usr/bin/env node\n` +
    `const fs = require("node:fs");\n` +
    `const argv = process.argv.slice(2);\n` +
    `if (argv[0] === "--version") { process.stdout.write("${STUB_VERSION}\\n"); process.exit(0); }\n` +
    `const interesting = ${JSON.stringify(interestingEnvVars)};\n` +
    `const env = {};\n` +
    `for (const k of interesting) if (process.env[k] !== undefined) env[k] = process.env[k];\n` +
    `fs.writeFileSync(${JSON.stringify(opts.capturePath)}, JSON.stringify({ argv, env, agent: ${JSON.stringify(opts.agent)} }, null, 2));\n` +
    `process.stdout.write("stub-${opts.agent}-ok\\n");\n` +
    `process.exit(0);\n`;

  if (process.platform === "win32") {
    const jsPath = path.join(binDir, `${opts.agent}.js`);
    fs.writeFileSync(jsPath, jsScript);
    const cmdPath = path.join(binDir, `${opts.agent}.cmd`);
    fs.writeFileSync(cmdPath, `@node "${jsPath}" %*\r\n`);
  } else {
    const shimPath = path.join(binDir, opts.agent);
    fs.writeFileSync(shimPath, jsScript, { mode: 0o755 });
  }

  return { binDir, capturePath: opts.capturePath };
}

/**
 * Build an installable npm tarball that, when `npm install`ed, lays down a
 * working stub bin under node_modules/.bin/<agent> matching createAgentStub's
 * behavior. Returns the absolute path to the tarball.
 */
export function buildAgentStubTarball(opts: {
  dir: string;
  agent: AgentName;
  capturePath: string;
  packageName: string;
  version: string;
}): string {
  const stagingDir = path.join(opts.dir, "tarball-staging");
  fs.mkdirSync(stagingDir, { recursive: true });

  const interestingEnvVars =
    opts.agent === "codex"
      ? ["CODEX_HOME"]
      : opts.agent === "pi"
      ? ["HOME", "PI_CODING_AGENT_DIR"]
      : [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
        ];

  const jsScript =
    `#!/usr/bin/env node\n` +
    `const fs = require("node:fs");\n` +
    `const argv = process.argv.slice(2);\n` +
    `if (argv[0] === "--version") { process.stdout.write(${JSON.stringify(opts.version)} + "\\n"); process.exit(0); }\n` +
    `const interesting = ${JSON.stringify(interestingEnvVars)};\n` +
    `const env = {};\n` +
    `for (const k of interesting) if (process.env[k] !== undefined) env[k] = process.env[k];\n` +
    `fs.writeFileSync(${JSON.stringify(opts.capturePath)}, JSON.stringify({ argv, env, agent: ${JSON.stringify(opts.agent)}, source: "installed" }, null, 2));\n` +
    `process.stdout.write("installed-${opts.agent}-ok\\n");\n` +
    `process.exit(0);\n`;

  const binFileName = `${opts.agent}-bin.js`;
  fs.writeFileSync(path.join(stagingDir, binFileName), jsScript, { mode: 0o755 });

  const pkgJson = {
    name: opts.packageName,
    version: opts.version,
    bin: { [opts.agent]: `./${binFileName}` }
  };
  fs.writeFileSync(path.join(stagingDir, "package.json"), JSON.stringify(pkgJson, null, 2));

  // Run `npm pack` to produce a tarball
  const packResult = spawnSync("npm", ["pack", "--silent"], {
    cwd: stagingDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  if (packResult.status !== 0) {
    throw new Error(`npm pack failed in ${stagingDir}: ${packResult.stderr?.toString() ?? "(no stderr)"}`);
  }
  const tarballName = packResult.stdout.toString().trim().split(/\s+/).pop();
  if (!tarballName) throw new Error("npm pack did not print a tarball name");
  return path.join(stagingDir, tarballName);
}

/**
 * Build a fake `npm` shim that intercepts the two commands resolveAgent uses:
 *   - `npm view <pkg> version` → prints the configured version
 *   - `npm install --prefix <dir> --no-audit --no-fund --omit=dev <pkg>@<ver>`
 *     → installs by copying a prepared tarball
 *
 * The shim defers all other invocations to the real npm.
 *
 * Returns the bin directory containing the `npm` shim.
 */
export function createFakeNpm(opts: {
  dir: string;
  packageName: string;
  version: string;
  tarballPath: string;
}): { binDir: string } {
  const binDir = path.join(opts.dir, "fake-npm-bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeNodeShim(binDir);

  // Resolve real npm so the shim can fall through for unsupported cases.
  const realNpm = locateRealNpm();

  const shimScript =
    `#!/usr/bin/env node\n` +
    `const { spawnSync } = require("node:child_process");\n` +
    `const fs = require("node:fs");\n` +
    `const path = require("node:path");\n` +
    `const argv = process.argv.slice(2);\n` +
    `const PKG = ${JSON.stringify(opts.packageName)};\n` +
    `const VER = ${JSON.stringify(opts.version)};\n` +
    `const TARBALL = ${JSON.stringify(opts.tarballPath)};\n` +
    `const REAL = ${JSON.stringify(realNpm ?? "")};\n` +
    `function delegate() {\n` +
    `  if (!REAL) { process.stderr.write("fake-npm: real npm not located, refusing\\n"); process.exit(1); }\n` +
    `  const r = spawnSync(REAL, argv, { stdio: "inherit", shell: process.platform === "win32" });\n` +
    `  process.exit(r.status ?? 1);\n` +
    `}\n` +
    `if (argv[0] === "view" && argv[1] === PKG && argv[2] === "version") {\n` +
    `  process.stdout.write(VER + "\\n"); process.exit(0);\n` +
    `}\n` +
    `if (argv[0] === "install") {\n` +
    `  const prefixIdx = argv.indexOf("--prefix");\n` +
    `  const prefix = prefixIdx >= 0 ? argv[prefixIdx + 1] : null;\n` +
    `  const spec = argv[argv.length - 1];\n` +
    `  if (prefix && spec === PKG + "@" + VER) {\n` +
    `    const r = spawnSync(REAL, ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--omit=dev", TARBALL], { stdio: "inherit", shell: process.platform === "win32" });\n` +
    `    process.exit(r.status ?? 1);\n` +
    `  }\n` +
    `}\n` +
    `delegate();\n`;

  if (process.platform === "win32") {
    const jsPath = path.join(binDir, "npm.js");
    fs.writeFileSync(jsPath, shimScript);
    const cmdPath = path.join(binDir, "npm.cmd");
    fs.writeFileSync(cmdPath, `@node "${jsPath}" %*\r\n`);
  } else {
    const shimPath = path.join(binDir, "npm");
    fs.writeFileSync(shimPath, shimScript, { mode: 0o755 });
  }

  return { binDir };
}

export function writeNodeShim(binDir: string): void {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "node.cmd"), `@"${process.execPath}" %*\r\n`);
    return;
  }
  fs.writeFileSync(path.join(binDir, "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
}

function locateRealNpm(): null | string {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : [""];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `npm${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}
