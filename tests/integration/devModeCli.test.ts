import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// End-to-end coverage of the `--dev` global flag wiring: the daemon home must be
// redirected to an isolated dev home (so a dev daemon never shares a lock/port
// with a production copillm), an explicit COPILLM_HOME must still win, and the
// flag must be inert when absent.

const CLI_ENTRY = path.resolve(__dirname, "..", "..", "dist", "cli.js");

const OVERRIDE_KEYS = [
  "COPILLM_HOME",
  "COPILLM_PORT",
  "COPILLM_DEV",
  "COPILLM_DEV_HOME",
  "COPILLM_DEV_PORT"
] as const;

interface StatusPayload {
  copillm_home: string;
  dev_mode: boolean;
  running: boolean;
}

let devHome: string;
let altHome: string;
let fakeHome: string;

beforeEach(() => {
  devHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-devmode-"));
  altHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-devmode-alt-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-devmode-fakehome-"));
});

afterEach(() => {
  for (const dir of [devHome, altHome, fakeHome]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runStatus(args: string[], extraEnv: Record<string, string>): StatusPayload {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    // Keep the run hermetic: no keychain reads, no registry update check.
    COPILLM_FORCE_SESSION_BACKEND: "1",
    NO_UPDATE_NOTIFIER: "1"
  };
  for (const key of OVERRIDE_KEYS) {
    delete env[key];
  }
  Object.assign(env, extraEnv);

  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args, "status", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    env
  });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as StatusPayload;
}

describe("copillm --dev (daemon home isolation)", () => {
  it("redirects COPILLM_HOME to the isolated dev home", () => {
    const status = runStatus(["--dev"], { COPILLM_DEV_HOME: devHome });
    expect(status.dev_mode).toBe(true);
    expect(status.copillm_home).toBe(path.resolve(devHome));
  });

  it("activates from COPILLM_DEV without the flag", () => {
    const status = runStatus([], { COPILLM_DEV: "1", COPILLM_DEV_HOME: devHome });
    expect(status.dev_mode).toBe(true);
    expect(status.copillm_home).toBe(path.resolve(devHome));
  });

  it("never overrides an explicitly set COPILLM_HOME", () => {
    const status = runStatus(["--dev"], { COPILLM_HOME: altHome, COPILLM_DEV_HOME: devHome });
    expect(status.dev_mode).toBe(true);
    expect(status.copillm_home).toBe(path.resolve(altHome));
  });

  it("does not redirect the home when the flag is absent", () => {
    const status = runStatus([], { COPILLM_HOME: altHome });
    expect(status.dev_mode).toBe(false);
    expect(status.copillm_home).toBe(path.resolve(altHome));
  });
});
