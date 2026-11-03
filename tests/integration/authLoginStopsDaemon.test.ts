import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PR — a successful `auth login` stops a running daemon so it picks up the
 * new default account on the next launch. `stopByPid` is stubbed so the test
 * never actually terminates the (alive) test process holding the lock.
 */

const loginMock = vi.fn<() => Promise<string>>();
const identityMock = vi.fn<(opts: { token?: string }) => Promise<{ login: string; name: string | null } | null>>();
const stopByPidMock = vi.fn<(pid: number) => Promise<void>>();

vi.mock("../../src/auth/deviceFlow.js", () => ({
  loginViaDeviceFlow: () => loginMock()
}));
vi.mock("../../src/auth/githubIdentity.js", () => ({
  inspectGithubIdentity: (opts: { token?: string }) => identityMock(opts)
}));
vi.mock("../../src/cli/daemon/lifecycle.js", () => ({
  stopByPid: (...args: unknown[]) => stopByPidMock(...(args as [number]))
}));

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-login-daemon-"));
  savedEnv.COPILLM_HOME = process.env.COPILLM_HOME;
  savedEnv.COPILLM_FORCE_SESSION_BACKEND = process.env.COPILLM_FORCE_SESSION_BACKEND;
  process.env.COPILLM_HOME = tmpHome;
  process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  loginMock.mockReset();
  identityMock.mockReset();
  stopByPidMock.mockReset();
  identityMock.mockImplementation(async ({ token }) => {
    if (token === "tok-octocat") return { login: "octocat", name: "Octo Cat" };
    if (token === "tok-work") return { login: "work-login", name: null };
    return { login: "someone", name: null };
  });
  const creds = await import("../../src/auth/credentials.js");
  creds.__resetSessionCredentialForTests();
});

afterEach(async () => {
  for (const key of ["COPILLM_HOME", "COPILLM_FORCE_SESSION_BACKEND"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  const { releaseLock } = await import("../../src/server/lock.js");
  await releaseLock();
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${code ?? 0}__`);
  }) as typeof process.exit;

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

describe("auth login stops a running daemon", () => {
  it("stops the daemon after adding a second account (default changes)", async () => {
    const { acquireLock } = await import("../../src/server/lock.js");
    await acquireLock(4141); // simulate a running daemon

    loginMock.mockResolvedValueOnce("tok-octocat");
    await runCli(["auth", "login", "--force-session"]);
    expect(stopByPidMock).toHaveBeenCalled();
    stopByPidMock.mockReset();

    loginMock.mockResolvedValueOnce("tok-work");
    await runCli(["auth", "login", "--as", "work", "--force-session"]);
    expect(stopByPidMock).toHaveBeenCalled();
  });

  it("does not call stopByPid when no daemon is running", async () => {
    loginMock.mockResolvedValueOnce("tok-octocat");
    await runCli(["auth", "login", "--force-session"]);
    expect(stopByPidMock).not.toHaveBeenCalled();
  });
});
