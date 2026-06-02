import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end guard for `copillm copilot`: the launcher must inject the stored
// GitHub OAuth token into the child process's environment as
// COPILOT_GITHUB_TOKEN (so GitHub Copilot CLI skips its own device flow), but
// it must NEVER leak that token to the parent stdout/stderr. We stand up a
// fake `copilot` shim on PATH that records its environment to disk and exits,
// then assert the relay happened and the token did not appear in the CLI's
// own output streams.

const SECRET_TOKEN = "gho_COPILOT_LAUNCHER_TEST_TOKEN_xyz9876543210ABC";

const cliPath = path.resolve(__dirname, "..", "..", "dist", "cli.js");

let tmpHome: string | undefined;
let shimDir: string | undefined;
let envDumpPath: string | undefined;

function writeShim(dir: string, dumpPath: string): string {
  if (process.platform === "win32") {
    // Vitest doesn't drive Windows for these spawn-based shim tests today, but
    // emit a .cmd shim anyway so accidental Windows runs fail loudly rather
    // than silently picking up a different copilot on PATH.
    const cmdPath = path.join(dir, "copilot.cmd");
    fs.writeFileSync(
      cmdPath,
      `@echo off\r\n` +
        `echo {"COPILOT_GITHUB_TOKEN":"%COPILOT_GITHUB_TOKEN%"} > "${dumpPath}"\r\n` +
        `exit /b 0\r\n`
    );
    return cmdPath;
  }
  const shPath = path.join(dir, "copilot");
  fs.writeFileSync(
    shPath,
    `#!/usr/bin/env bash\n` +
      `if [ "$1" = "--version" ]; then\n` +
      `  echo "shim 0.0.0"\n` +
      `  exit 0\n` +
      `fi\n` +
      `printf '{"COPILOT_GITHUB_TOKEN":"%s"}\\n' "$COPILOT_GITHUB_TOKEN" > "${dumpPath}"\n` +
      `exit 0\n`,
    { mode: 0o755 }
  );
  return shPath;
}

beforeAll(() => {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI artifact missing at ${cliPath} — globalSetup did not run.`);
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-copilot-launcher-"));
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-copilot-shim-"));
  envDumpPath = path.join(shimDir, "env-dump.json");
  writeShim(shimDir, envDumpPath);
  fs.writeFileSync(
    path.join(tmpHome, "credentials.json"),
    JSON.stringify(
      {
        version: 1,
        github_token: SECRET_TOKEN,
        account_type: "individual",
        saved_at: new Date().toISOString()
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
});

afterAll(() => {
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true });
});

describe("copillm copilot launcher", () => {
  it("injects the stored GitHub token into the child env without leaking it to output", () => {
    if (process.platform === "win32") {
      // Skip on Windows for now — the shim model above is POSIX-shell-centric.
      // Linux + macOS coverage in the matrix is sufficient for this guard.
      return;
    }
    if (!tmpHome || !shimDir || !envDumpPath) {
      throw new Error("test setup did not complete");
    }

    const pathSep = ":";
    const childPath = `${shimDir}${pathSep}${process.env.PATH ?? ""}`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: childPath,
      COPILLM_HOME: tmpHome,
      COPILLM_ALLOW_PLAINTEXT_CREDENTIALS: "1",
      // Stubbed copilot binary lives on PATH for this test; opt in to the PATH lookup.
      COPILLM_USE_SYSTEM_AGENT: "1"
    };
    // Ensure we never pre-set the token in the parent env — the launcher
    // must derive it from the stored credential.
    delete env.COPILOT_GITHUB_TOKEN;

    const result = spawnSync(
      process.execPath,
      [cliPath, "copilot", "--copillm-no-config"],
      { env, encoding: "utf8", timeout: 30_000 }
    );

    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status).toBe(0);

    const dump = JSON.parse(fs.readFileSync(envDumpPath, "utf8")) as {
      COPILOT_GITHUB_TOKEN: string;
    };
    expect(dump.COPILOT_GITHUB_TOKEN).toBe(SECRET_TOKEN);

    // Critical: the parent process's stdout/stderr (the launcher's own
    // logging) must not echo the token under any condition. This mirrors
    // the substring guard in tests/authStatusCli.test.ts.
    expect(result.stdout).not.toContain(SECRET_TOKEN);
    expect(result.stderr).not.toContain(SECRET_TOKEN);
  });

  it("fails with a clear message when no credential is stored", () => {
    if (process.platform === "win32") return;
    if (!shimDir) throw new Error("test setup did not complete");

    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-copilot-empty-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        COPILLM_HOME: emptyHome,
        COPILLM_ALLOW_PLAINTEXT_CREDENTIALS: "1",
        COPILLM_FORCE_SESSION_BACKEND: "1",
        COPILLM_USE_SYSTEM_AGENT: "1"
      };
      delete env.COPILOT_GITHUB_TOKEN;

      const result = spawnSync(
        process.execPath,
        [cliPath, "copilot", "--copillm-no-config"],
        { env, encoding: "utf8", timeout: 15_000 }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/copillm auth login/);
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
