import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PR E — multi-account CLI surface driven through Commander. Device flow and
 * the GitHub identity lookup are stubbed; saves land on the in-memory session
 * backend so no keychain is touched.
 */

const loginMock = vi.fn<() => Promise<string>>();
const identityMock = vi.fn<(opts: { token?: string }) => Promise<{ login: string; name: string | null } | null>>();

vi.mock("../../src/auth/deviceFlow.js", () => ({
  loginViaDeviceFlow: () => loginMock()
}));
vi.mock("../../src/auth/githubIdentity.js", () => ({
  inspectGithubIdentity: (opts: { token?: string }) => identityMock(opts)
}));

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-cli-acct-"));
  savedEnv.COPILLM_HOME = process.env.COPILLM_HOME;
  savedEnv.COPILLM_FORCE_SESSION_BACKEND = process.env.COPILLM_FORCE_SESSION_BACKEND;
  process.env.COPILLM_HOME = tmpHome;
  process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  loginMock.mockReset();
  identityMock.mockReset();
  // Default identity: map known tokens to logins.
  identityMock.mockImplementation(async ({ token }) => {
    if (token === "tok-octocat") return { login: "octocat", name: "Octo Cat" };
    if (token === "tok-work") return { login: "work-login", name: null };
    return { login: "someone", name: null };
  });
  const creds = await import("../../src/auth/credentials.js");
  creds.__resetSessionCredentialForTests();
});

afterEach(() => {
  for (const key of ["COPILLM_HOME", "COPILLM_FORCE_SESSION_BACKEND"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number | null }> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalExit = process.exit;
  let exitCode: number | null = null;

  (process.stdout as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${code ?? 0}__`);
  }) as never;

  process.exitCode = undefined;
  try {
    const { Command } = await import("commander");
    const { register } = await import("../../src/cli/commands/auth.js");
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
  if (exitCode === null && typeof process.exitCode === "number") {
    exitCode = process.exitCode;
  }
  process.exitCode = undefined;
  return { stdout: writes.join(""), exitCode };
}

describe("auth multi-account CLI", () => {
  it("single-account login creates no accounts index", async () => {
    loginMock.mockResolvedValueOnce("tok-octocat");
    const res = await runCli(["auth", "login", "--force-session", "--json"]);
    const payload = JSON.parse(res.stdout) as { status: string; account?: string };
    expect(payload.status).toBe("ok");
    expect(payload.account).toBeUndefined();
    expect(fs.existsSync(path.join(tmpHome, "accounts.json"))).toBe(false);
  });

  it("login --as adds a named account and preserves the prior default", async () => {
    loginMock.mockResolvedValueOnce("tok-octocat");
    await runCli(["auth", "login", "--force-session"]);
    loginMock.mockResolvedValueOnce("tok-work");
    const res = await runCli(["auth", "login", "--as", "work", "--account-type", "business", "--force-session", "--json"]);
    const payload = JSON.parse(res.stdout) as { account: string; is_default: boolean; account_type: string };
    expect(payload.account).toBe("work");
    expect(payload.is_default).toBe(false);
    expect(payload.account_type).toBe("business");

    // Index now has the materialized default (octocat) plus work.
    const index = JSON.parse(fs.readFileSync(path.join(tmpHome, "accounts.json"), "utf8")) as {
      defaultAccount: string;
      accounts: { id: string; storage: string }[];
    };
    expect(index.defaultAccount).toBe("octocat");
    expect(index.accounts.map((a) => a.id).sort()).toEqual(["octocat", "work"]);
    expect(index.accounts.find((a) => a.id === "octocat")?.storage).toBe("legacy");
    expect(index.accounts.find((a) => a.id === "work")?.storage).toBe("namespaced");
  });

  it("status lists every account with the default marked, never printing a token", async () => {
    loginMock.mockResolvedValueOnce("tok-octocat");
    await runCli(["auth", "login", "--force-session"]);
    loginMock.mockResolvedValueOnce("tok-work");
    await runCli(["auth", "login", "--as", "work", "--force-session"]);

    const res = await runCli(["auth", "status", "--json"]);
    const payload = JSON.parse(res.stdout) as {
      status: string;
      default: string;
      accounts: { id: string; default: boolean; user: { login: string } | null }[];
    };
    expect(res.exitCode).toBe(0);
    expect(payload.status).toBe("logged_in");
    expect(payload.default).toBe("octocat");
    expect(payload.accounts.find((a) => a.id === "octocat")?.default).toBe(true);
    expect(payload.accounts.find((a) => a.id === "work")?.user?.login).toBe("work-login");
    // Token-leak guard.
    expect(res.stdout).not.toContain("tok-octocat");
    expect(res.stdout).not.toContain("tok-work");
  });

  it("switch changes the default account", async () => {
    loginMock.mockResolvedValueOnce("tok-octocat");
    await runCli(["auth", "login", "--force-session"]);
    loginMock.mockResolvedValueOnce("tok-work");
    await runCli(["auth", "login", "--as", "work", "--force-session"]);

    const res = await runCli(["auth", "switch", "work", "--json"]);
    const payload = JSON.parse(res.stdout) as { status: string; default_account: string };
    expect(payload.status).toBe("ok");
    expect(payload.default_account).toBe("work");

    const { getDefaultAccountId } = await import("../../src/auth/accounts.js");
    expect(getDefaultAccountId()).toBe("work");
  });

  it("switch to an unknown account fails with exit code 1", async () => {
    loginMock.mockResolvedValueOnce("tok-octocat");
    await runCli(["auth", "login", "--force-session"]);
    loginMock.mockResolvedValueOnce("tok-work");
    await runCli(["auth", "login", "--as", "work", "--force-session"]);

    const res = await runCli(["auth", "switch", "ghost", "--json"]);
    const payload = JSON.parse(res.stdout) as { status: string };
    expect(payload.status).toBe("error");
    expect(res.exitCode).toBe(1);
  });

  it("logout --account removes one account and reassigns the default", async () => {
    loginMock.mockResolvedValueOnce("tok-octocat");
    await runCli(["auth", "login", "--force-session"]);
    loginMock.mockResolvedValueOnce("tok-work");
    await runCli(["auth", "login", "--as", "work", "--force-session"]);

    const res = await runCli(["auth", "logout", "--account", "octocat", "--json"]);
    const payload = JSON.parse(res.stdout) as { status: string; new_default: string };
    expect(payload.status).toBe("ok");
    expect(payload.new_default).toBe("work");

    const { loadStoredCredentialForAccount } = await import("../../src/auth/credentials.js");
    expect(await loadStoredCredentialForAccount("octocat")).toBeNull();
    expect((await loadStoredCredentialForAccount("work"))?.token).toBe("tok-work");
  });

  it("logout --all clears every account and deletes the index", async () => {
    loginMock.mockResolvedValueOnce("tok-octocat");
    await runCli(["auth", "login", "--force-session"]);
    loginMock.mockResolvedValueOnce("tok-work");
    await runCli(["auth", "login", "--as", "work", "--force-session"]);

    const res = await runCli(["auth", "logout", "--all", "--json"]);
    const payload = JSON.parse(res.stdout) as { status: string; cleared_count: number };
    expect(payload.status).toBe("ok");
    expect(payload.cleared_count).toBe(2);
    expect(fs.existsSync(path.join(tmpHome, "accounts.json"))).toBe(false);

    const statusRes = await runCli(["auth", "status", "--json", "--no-user"]);
    const statusPayload = JSON.parse(statusRes.stdout) as { status: string };
    expect(statusPayload.status).toBe("logged_out");
    expect(statusRes.exitCode).toBe(2);
  });
});
