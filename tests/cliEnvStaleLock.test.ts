import { spawn, spawnSync } from "node:child_process";
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
let deadPid: number | undefined;
const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

function ensureCliBuilt(): void {
  const repoRoot = path.resolve(__dirname, "..");
  const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tscEntry, "-p", "tsconfig.json"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build CLI for stale-lock test (exit=${result.status ?? "null"}).`);
  }
}

async function spawnAndAwaitDeath(): Promise<number> {
  // Spawn a tiny child that exits immediately, capture its pid, wait for
  // it to fully exit. Far more reliable than picking an arbitrary high
  // pid (which could collide on long-running systems).
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    if (typeof child.pid !== "number") {
      reject(new Error("Failed to obtain child pid"));
      return;
    }
    const pid = child.pid;
    child.once("exit", () => {
      // Give the OS a moment to fully reap; on Windows in particular,
      // process.kill(pid, 0) immediately after exit can briefly return
      // success before the kernel finishes cleanup.
      setTimeout(() => resolve(pid), 100);
    });
    child.once("error", reject);
  });
}

beforeAll(async () => {
  ensureCliBuilt();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-stale-lock-"));
  deadPid = await spawnAndAwaitDeath();
  // Write a lockfile whose pid is dead → inspectLock returns
  // { state: "stale", reason: "pid_not_alive", ... }.
  fs.writeFileSync(
    path.join(tmpHome, "copillm.pid"),
    JSON.stringify(
      {
        pid: deadPid,
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
