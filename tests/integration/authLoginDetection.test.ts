import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keyring unavailable → credentials land in the plaintext file backend, which
// (like the real OS keychain) persists across separate `auth login` commands.
// This reproduces real multi-process behaviour that the force-session tests
// (in-memory, single-process) could not.
vi.mock("@napi-rs/keyring", () => ({ AsyncEntry: null, default: null }));

const loginMock = vi.fn<() => Promise<string>>();
const identityMock = vi.fn<(opts: { token?: string }) => Promise<{ login: string; name: string | null } | null>>();

vi.mock("../../src/auth/deviceFlow.js", () => ({ loginViaDeviceFlow: () => loginMock() }));
vi.mock("../../src/auth/githubIdentity.js", () => ({ inspectGithubIdentity: (o: { token?: string }) => identityMock(o) }));

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-login-detect-"));
  for (const k of ["COPILLM_HOME", "COPILLM_FORCE_SESSION_BACKEND", "COPILLM_ALLOW_PLAINTEXT_CREDENTIALS"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.COPILLM_HOME = tmpHome;
  delete process.env.COPILLM_FORCE_SESSION_BACKEND;
  process.env.COPILLM_ALLOW_PLAINTEXT_CREDENTIALS = "1";
  loginMock.mockReset();
  identityMock.mockReset();
  identityMock.mockImplementation(async ({ token }) => {
    if (token === "tok-alice") return { login: "alice", name: "Alice" };
    if (token === "tok-bob") return { login: "bob", name: "Bob" };
    return null;
  });
  const creds = await import("../../src/auth/credentials.js");
  creds.__resetSessionCredentialForTests();
});

afterEach(() => {
  for (const k of ["COPILLM_HOME", "COPILLM_FORCE_SESSION_BACKEND", "COPILLM_ALLOW_PLAINTEXT_CREDENTIALS"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number | null }> {
  const writes: string[] = [];
  const ow = process.stdout.write.bind(process.stdout);
  const oe = process.exit;
  let exitCode: number | null = null;
  (process.stdout as { write: typeof process.stdout.write }).write = ((c: string | Uint8Array) => {
    writes.push(typeof c === "string" ? c : c.toString());
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
    if (!(err instanceof Error) || !err.message.startsWith("__exit_")) throw err;
  } finally {
    (process.stdout as { write: typeof process.stdout.write }).write = ow;
    (process as { exit: typeof oe }).exit = oe;
  }
  if (exitCode === null && typeof process.exitCode === "number") exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stdout: writes.join(""), exitCode };
}

describe("auth login — multi-account detection (regression for beta wipe bug)", () => {
  it("logging into a DIFFERENT GitHub account keeps the prior one (no --as)", async () => {
    loginMock.mockResolvedValueOnce("tok-alice");
    await runCli(["auth", "login"]);
    loginMock.mockResolvedValueOnce("tok-bob");
    await runCli(["auth", "login"]);

    const res = await runCli(["auth", "status", "--json"]);
    const payload = JSON.parse(res.stdout) as { accounts?: { id: string }[]; stored?: boolean };
    const ids = (payload.accounts ?? []).map((a) => a.id).sort();
    expect(ids).toEqual(["alice", "bob"]);
  });

  it("logging into the SAME account twice does not create a spurious second account", async () => {
    loginMock.mockResolvedValueOnce("tok-alice");
    await runCli(["auth", "login"]);
    loginMock.mockResolvedValueOnce("tok-alice");
    await runCli(["auth", "login"]);

    // Same login → still single-account, no index created.
    expect(fs.existsSync(path.join(tmpHome, "accounts.json"))).toBe(false);
    const res = await runCli(["auth", "status", "--json"]);
    const payload = JSON.parse(res.stdout) as { stored?: boolean; status: string };
    expect(payload.status).toBe("logged_in");
  });

  it("--as still preserves the prior default account", async () => {
    loginMock.mockResolvedValueOnce("tok-alice");
    await runCli(["auth", "login"]);
    loginMock.mockResolvedValueOnce("tok-bob");
    await runCli(["auth", "login", "--as", "work"]);

    const res = await runCli(["auth", "status", "--json"]);
    const payload = JSON.parse(res.stdout) as { accounts?: { id: string }[] };
    const ids = (payload.accounts ?? []).map((a) => a.id).sort();
    expect(ids).toEqual(["alice", "work"]);
  });
});
