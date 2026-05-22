import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end guard: invoke the built CLI in a child process with a credential
// file containing a recognisable token, then verify that `auth status` and
// `status` never echo that token to stdout (human OR --json modes).
//
// This protects against accidental regressions where someone wires the
// auth-introspection path through `loadStoredCredential` (which returns the
// token) rather than `inspectStoredCredential` (which doesn't).

const SECRET_TOKEN = "gho_NEVER_LEAK_THIS_TOKEN_abc1234567890DEF";

let tmpHome: string | undefined;
const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

function ensureCliBuilt(): void {
  // Always rebuild — unit tests don't run through any pre-build step and the
  // on-disk dist/ may not match the in-tree src/ we're trying to validate.
  // Invoke tsc directly via node rather than going through `npm run build`
  // so we don't depend on `npm.cmd` resolution (Windows) and avoid Node's
  // "shell: true with args" deprecation warning.
  const repoRoot = path.resolve(__dirname, "..");
  const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tscEntry, "-p", "tsconfig.json"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build CLI for token-leak test (exit=${result.status ?? "null"}).`);
  }
}

beforeAll(() => {
  ensureCliBuilt();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-leak-"));
  fs.mkdirSync(tmpHome, { recursive: true });
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
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function runCli(args: string[]): { stdout: string; stderr: string; code: null | number } {
  if (!tmpHome) {
    throw new Error("tmpHome was not initialised; beforeAll() must have failed.");
  }
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      COPILLM_HOME: tmpHome,
      // Bypass keychain so the file backend is exercised.
      COPILLM_FORCE_SESSION_BACKEND: undefined as unknown as string,
      // Point the GitHub /user lookup at an unroutable endpoint so the test
      // stays hermetic. The auth-status path is expected to fail gracefully
      // (timeout / connection refused) and fall back to the no-user line.
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

describe("CLI token-leak guard", () => {
  it("auth status (human) reports logged in without printing the token", () => {
    const { stdout, code } = runCli(["auth", "status"]);
    expect(code).toBe(0);
    expect(stdout).toContain("logged in");
    expect(stdout).not.toContain(SECRET_TOKEN);
  });

  it("auth status --json reports stored: true without printing the token", () => {
    const { stdout, code } = runCli(["auth", "status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.status).toBe("logged_in");
    expect(parsed.stored).toBe(true);
    expect(stdout).not.toContain(SECRET_TOKEN);
  });

  it("status (human) includes an auth line without printing the token", () => {
    const { stdout } = runCli(["status"]);
    expect(stdout).toContain("auth: logged in");
    expect(stdout).not.toContain(SECRET_TOKEN);
  });

  it("status --json includes an auth block without printing the token", () => {
    const { stdout } = runCli(["status", "--json"]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.auth).toMatchObject({ stored: true, backend: "file" });
    expect(stdout).not.toContain(SECRET_TOKEN);
  });
});
