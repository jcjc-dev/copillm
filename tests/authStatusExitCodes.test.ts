import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The `auth status` command's exit-code contract is documented in README:
// 0 if logged in, 2 if not, 1 on error. Scripts depend on this for
// auth-gated automation. The existing token-leak suite only asserts the
// happy path (code 0); this suite locks down the not-logged-in branch
// (code 2) so a refactor can't silently change it without a test failure.

let tmpHomeLoggedOut: string | undefined;
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
  // tmpHome with NO credentials.json: the file backend will be absent and
  // (because COPILLM_FORCE_SESSION_BACKEND=1) the keychain backend won't be
  // probed either, so inspectStoredCredential returns { stored: false }.
  tmpHomeLoggedOut = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-logged-out-"));
});

afterAll(() => {
  if (tmpHomeLoggedOut) {
    fs.rmSync(tmpHomeLoggedOut, { recursive: true, force: true });
  }
});

function runCli(args: string[]): { stdout: string; stderr: string; code: null | number } {
  if (!tmpHomeLoggedOut) {
    throw new Error("test setup did not complete");
  }
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      COPILLM_HOME: tmpHomeLoggedOut,
      // Force the in-memory session backend so the keychain isn't probed and
      // we get a deterministic "not stored" result on macOS/Linux/Windows.
      COPILLM_FORCE_SESSION_BACKEND: "1",
      // Block the /user lookup so the test doesn't depend on network reachability.
      COPILLM_GITHUB_USER_URL: "http://127.0.0.1:1/never"
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

describe("CLI auth status exit codes", () => {
  it("exits 2 when no credential is stored (human output)", () => {
    const { stdout, code } = runCli(["auth", "status"]);
    expect(code).toBe(2);
    expect(stdout.trim()).toBe("not logged in");
  });

  it("exits 2 when no credential is stored (--json output)", () => {
    const { stdout, code } = runCli(["auth", "status", "--json"]);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout) as { status?: string; stored?: boolean; backend?: null | string };
    expect(parsed.status).toBe("logged_out");
    expect(parsed.stored).toBe(false);
    expect(parsed.backend).toBeNull();
  });

  it("--no-user still exits 2 when not logged in (lookup is skipped before exit-code decision)", () => {
    const { stdout, code } = runCli(["auth", "status", "--no-user"]);
    expect(code).toBe(2);
    expect(stdout.trim()).toBe("not logged in");
  });
});
