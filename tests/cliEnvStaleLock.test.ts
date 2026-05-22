import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `copillm env <agent>` covers three lock states:
//  - running → emit env block (covered by e2e/pr-gate-runner)
//  - missing → exit 2 with "not running" (covered by e2e/pr-gate-runner)
//  - stale   → exit 2 with "stale lock (...)" message
// Only the third was untested — a regression there would leave users with
// a cryptic error when the daemon crashed and left a lockfile behind.

let tmpHome: string | undefined;
const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

function ensureCliBuilt(): void {
  // CLI is built once via vitest globalSetup (tests/globalBuild.ts); see
  // that file for why per-file builds were removed.
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI artifact missing at ${cliPath} — globalSetup did not run.`);
  }
}

beforeAll(() => {
  ensureCliBuilt();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-stale-lock-"));
  // Use a schema-invalid lock file (missing pid) → inspectLock() returns
  // { state: "stale", reason: "lock_schema_invalid", ... }. This avoids the
  // dead-pid approach, which is racy: the OS can reuse a freshly-reaped pid
  // for an unrelated process between test setup and the CLI invocation,
  // making inspectLock() report "running" and the CLI exit 1 instead of 2.
  // The user-facing stale-lock message and exit code are identical for both
  // reasons, so this gives us the same coverage with zero PID-reuse risk.
  fs.writeFileSync(
    path.join(tmpHome, "copillm.pid"),
    JSON.stringify(
      {
        port: 14141,
        started_at_iso: new Date().toISOString()
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
});

afterAll(() => {
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function runCli(args: string[]): { stdout: string; stderr: string; code: null | number } {
  if (!tmpHome) {
    throw new Error("test setup did not complete");
  }
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      COPILLM_HOME: tmpHome,
      COPILLM_FORCE_SESSION_BACKEND: "1"
    },
    encoding: "utf8",
    timeout: 15_000
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status
  };
}

describe("copillm env with a stale lock", () => {
  it("exits 2 with a stale-lock message (codex, human output)", () => {
    const { stderr, stdout, code } = runCli(["env", "codex"]);
    expect(code).toBe(2);
    expect(stderr).toContain("stale lock");
    expect(stderr).toContain("copillm stop");
    expect(stderr).toContain("copillm start --detach");
    expect(stdout).toBe("");
  });

  it("exits 2 with a stale-lock message (claude, human output)", () => {
    const { stderr, code } = runCli(["env", "claude"]);
    expect(code).toBe(2);
    expect(stderr).toContain("stale lock");
  });

  it("exits 2 with structured error in --json mode (codex)", () => {
    const { stdout, code } = runCli(["env", "codex", "--json"]);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout) as { status?: string; agent?: string; error?: string };
    expect(parsed.status).toBe("not_running");
    expect(parsed.agent).toBe("codex");
    expect(parsed.error).toContain("stale lock");
  });

  it("exits 2 with structured error in --json mode (claude)", () => {
    const { stdout, code } = runCli(["env", "claude", "--json"]);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout) as { status?: string; agent?: string; error?: string };
    expect(parsed.status).toBe("not_running");
    expect(parsed.agent).toBe("claude");
    expect(parsed.error).toContain("stale lock");
  });

  it("exits 2 with a stale-lock message (pi, human output)", () => {
    const { stderr, code } = runCli(["env", "pi"]);
    expect(code).toBe(2);
    expect(stderr).toContain("stale lock");
  });

  it("exits 2 with structured error in --json mode (pi)", () => {
    const { stdout, code } = runCli(["env", "pi", "--json"]);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout) as { status?: string; agent?: string; error?: string };
    expect(parsed.status).toBe("not_running");
    expect(parsed.agent).toBe("pi");
    expect(parsed.error).toContain("stale lock");
  });
});
