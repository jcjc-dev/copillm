import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Unit test for PR 5 / Fix 12: coalesce keychain reads in `auth status`.
 *
 * Was: `auth status` called `inspectStoredCredential` (one `keyring.
 * getPassword` probe) then `inspectGithubIdentity` (which called
 * `loadStoredCredential` → a SECOND `keyring.getPassword` for the token).
 * That doubled macOS keychain audit-log entries and doubled
 * permission-prompt exposure on misconfigured systems.
 *
 * Now: when the user-lookup path runs, `loadStoredCredentialForStatus()`
 * does ONE keychain read that yields both backend AND token; the token
 * is passed through to `inspectGithubIdentity({ token })` which then
 * skips its own internal `loadStoredCredential` call.
 *
 * This test stubs `@napi-rs/keyring` so we can count `getPassword` calls
 * across the whole `auth status` action handler. It also stubs the GitHub
 * user lookup so we don't need network. Runs against a tmp `COPILLM_HOME`
 * so the file-backed fallback path is never accidentally taken.
 */

const keyringGetPasswordSpy = vi.fn<(service: string, account: string) => Promise<string | null>>();

vi.mock("@napi-rs/keyring", () => {
  // Build an AsyncEntry class that delegates to the spy.
  class FakeAsyncEntry {
    public constructor(private readonly service: string, private readonly account: string) {}
    async getPassword(): Promise<string | null> {
      return keyringGetPasswordSpy(this.service, this.account);
    }
    async setPassword(_password: string): Promise<void> {
      throw new Error("not used in this test");
    }
    async deletePassword(): Promise<void> {
      throw new Error("not used in this test");
    }
  }
  return { AsyncEntry: FakeAsyncEntry, default: { AsyncEntry: FakeAsyncEntry } };
});

// Stub the GitHub `/user` fetch so the user-lookup branch can succeed
// without network. We're not testing the user fetch here — only the
// keychain probe count.
vi.mock("../../../src/server/debugInfo.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/server/debugInfo.js")>(
    "../../../src/server/debugInfo.js"
  );
  return {
    ...actual,
    getGithubUserSummary: vi.fn(async () => ({
      login: "fake-login",
      id: 42,
      name: "Fake User",
      email: null,
      type: "User",
      avatar_url: null,
      html_url: null,
      plan_name: null
    }))
  };
});

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-auth-status-keyring-"));
  savedEnv.COPILLM_HOME = process.env.COPILLM_HOME;
  process.env.COPILLM_HOME = tmpHome;
  keyringGetPasswordSpy.mockReset();
});

afterEach(() => {
  if (savedEnv.COPILLM_HOME === undefined) {
    delete process.env.COPILLM_HOME;
  } else {
    process.env.COPILLM_HOME = savedEnv.COPILLM_HOME;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Drive the `auth status` action handler through Commander and capture
 * stdout/exit code. Returns a clean restorer to the caller.
 */
async function runAuthStatus(args: string[]): Promise<{ stdout: string; exitCode: null | number }> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalExit = process.exit;
  let exitCode: null | number = null;

  (process.stdout as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${code ?? 0}__`);
  }) as never;

  try {
    const { Command } = await import("commander");
    const { register } = await import("../../../src/cli/commands/auth.js");
    const program = new Command();
    program.exitOverride();
    register(program);
    await program.parseAsync(["node", "copillm", ...args]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("__exit_")) {
      throw err;
    }
  } finally {
    (process.stdout as { write: typeof process.stdout.write }).write = originalWrite;
    (process as { exit: typeof originalExit }).exit = originalExit;
  }

  return { stdout: writes.join(""), exitCode };
}

describe("auth status — keychain coalescing (Fix 12)", () => {
  it("with user lookup: keyring.getPassword called exactly ONCE (was 2× before this PR)", async () => {
    keyringGetPasswordSpy.mockResolvedValue("ghu_FAKE_TOKEN");
    const result = await runAuthStatus(["auth", "status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(keyringGetPasswordSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(result.stdout) as { status: string; user: null | { login: string } };
    expect(payload.status).toBe("logged_in");
    expect(payload.user?.login).toBe("fake-login");
  });

  it("with --no-user: keyring.getPassword called exactly ONCE (and via inspectStoredCredential — no token read)", async () => {
    keyringGetPasswordSpy.mockResolvedValue("ghu_FAKE_TOKEN");
    const result = await runAuthStatus(["auth", "status", "--no-user", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(keyringGetPasswordSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(result.stdout) as { status: string; user: null | unknown };
    expect(payload.status).toBe("logged_in");
    expect(payload.user).toBeNull();
  });

  it("when not logged in: keyring.getPassword called exactly ONCE and status is logged_out", async () => {
    keyringGetPasswordSpy.mockResolvedValue(null);
    const result = await runAuthStatus(["auth", "status", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(keyringGetPasswordSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(result.stdout) as { status: string };
    expect(payload.status).toBe("logged_out");
  });

  it("regression guard: the token itself never appears in stdout", async () => {
    // The repo's existing `tests/integration/authStatusCli.test.ts` enforces
    // this substring-leak invariant against the real CLI. Mirror it here
    // for the coalesced path so a refactor that accidentally hands the
    // token to `formatHumanAuthStatusLine` or the JSON payload trips this.
    keyringGetPasswordSpy.mockResolvedValue("ghu_SUPER_SECRET_TOKEN_FAKE");
    const result = await runAuthStatus(["auth", "status", "--json"]);
    expect(result.stdout).not.toContain("ghu_SUPER_SECRET_TOKEN_FAKE");
  });
});
