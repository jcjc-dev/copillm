import { describe, expect, it, vi } from "vitest";
import { ensureAuthenticatedInteractive, type EnsureAuthenticatedDeps } from "../../../src/auth/ensureAuthenticated.js";

// All seven decision branches of the interactive login flow get hit here.
// The function was previously untested — a regression in any branch (TTY
// detection, prompt wiring, save-fallback ladder, env-var gate) would
// silently break `copillm start` foreground login on real users' machines.

interface MockState {
  prints: string[];
  setEnvCalls: Array<{ key: string; value: string }>;
}

function buildDeps(overrides: Partial<EnsureAuthenticatedDeps> = {}): {
  deps: EnsureAuthenticatedDeps;
  state: MockState;
} {
  const state: MockState = { prints: [], setEnvCalls: [] };
  const deps: EnsureAuthenticatedDeps = {
    inspectStoredCredential: vi.fn(async () => ({ stored: false })),
    isTty: vi.fn(() => true),
    confirm: vi.fn(async () => true),
    choose: vi.fn(async () => "session" as const),
    loginViaDeviceFlow: vi.fn(async () => "gho_TEST_TOKEN_FAKE"),
    loadAccountType: vi.fn(() => "individual" as const),
    saveStoredCredential: vi.fn(async () => "keyring" as const),
    describeBackend: vi.fn((backend) => `<${backend ?? "null"}>`),
    print: vi.fn((line) => {
      state.prints.push(line);
    }),
    setEnv: vi.fn((key, value) => {
      state.setEnvCalls.push({ key, value });
    }),
    ...overrides
  };
  return { deps, state };
}

describe("ensureAuthenticatedInteractive — short-circuit paths", () => {
  it("returns silently when a credential is already stored", async () => {
    const { deps, state } = buildDeps({
      inspectStoredCredential: vi.fn(async () => ({ stored: true }))
    });
    await expect(ensureAuthenticatedInteractive(deps)).resolves.toBeUndefined();
    expect(deps.isTty).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.loginViaDeviceFlow).not.toHaveBeenCalled();
    expect(deps.saveStoredCredential).not.toHaveBeenCalled();
    expect(state.prints).toEqual([]);
  });

  it("throws when stdin is not a TTY and no credential is stored", async () => {
    const { deps } = buildDeps({
      isTty: vi.fn(() => false)
    });
    await expect(ensureAuthenticatedInteractive(deps)).rejects.toThrow(/stdin is not a TTY/);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.loginViaDeviceFlow).not.toHaveBeenCalled();
  });

  it("throws when the user declines the login prompt", async () => {
    const { deps } = buildDeps({
      confirm: vi.fn(async () => false)
    });
    await expect(ensureAuthenticatedInteractive(deps)).rejects.toThrow(/Aborted\./);
    expect(deps.loginViaDeviceFlow).not.toHaveBeenCalled();
    expect(deps.saveStoredCredential).not.toHaveBeenCalled();
  });
});

describe("ensureAuthenticatedInteractive — happy save path", () => {
  it("saves via the default backend without prompting when save succeeds", async () => {
    const { deps, state } = buildDeps({
      saveStoredCredential: vi.fn(async () => "keyring" as const)
    });
    await ensureAuthenticatedInteractive(deps);

    expect(deps.loginViaDeviceFlow).toHaveBeenCalledTimes(1);
    expect(deps.saveStoredCredential).toHaveBeenCalledTimes(1);
    expect(deps.saveStoredCredential).toHaveBeenCalledWith("gho_TEST_TOKEN_FAKE", "individual");
    // No fallback prompt should fire when save succeeds.
    expect(deps.choose).not.toHaveBeenCalled();
    // Final message should name the backend.
    expect(state.prints.some((line) => line.includes("Credentials stored via"))).toBe(true);
  });
});

describe("ensureAuthenticatedInteractive — fallback prompt branches", () => {
  it("when save throws and user chooses 'cancel', throws and never saves again", async () => {
    let saveCallCount = 0;
    const { deps } = buildDeps({
      saveStoredCredential: vi.fn(async () => {
        saveCallCount += 1;
        throw new Error("keychain unavailable");
      }),
      choose: vi.fn(async () => "cancel" as const)
    });
    await expect(ensureAuthenticatedInteractive(deps)).rejects.toThrow(/Login aborted\./);
    expect(saveCallCount).toBe(1); // only the initial failed attempt
  });

  it("when save throws and user chooses 'session', re-saves in session mode", async () => {
    let firstAttemptDone = false;
    const saveFn = vi.fn(async (_token: string, _accountType: string, options?: { mode?: string }) => {
      if (!firstAttemptDone) {
        firstAttemptDone = true;
        throw new Error("keychain unavailable");
      }
      expect(options?.mode).toBe("session");
      return "session" as const;
    });
    const { deps, state } = buildDeps({
      saveStoredCredential: saveFn,
      choose: vi.fn(async () => "session" as const)
    });
    await ensureAuthenticatedInteractive(deps);

    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(state.prints.some((line) => line.includes("Token kept in memory only"))).toBe(true);
  });

  it("when save throws and user chooses 'plaintext', sets the env-var gate and re-saves", async () => {
    let firstAttemptDone = false;
    const saveFn = vi.fn(async () => {
      if (!firstAttemptDone) {
        firstAttemptDone = true;
        throw new Error("keychain unavailable");
      }
      return "file" as const;
    });
    const { deps, state } = buildDeps({
      saveStoredCredential: saveFn,
      choose: vi.fn(async () => "plaintext" as const)
    });
    await ensureAuthenticatedInteractive(deps);

    expect(saveFn).toHaveBeenCalledTimes(2);
    // The env-var gate is the only way the plaintext fallback inside
    // credentials.ts will accept a write — losing this line silently breaks
    // the plaintext branch for users on machines without a keychain.
    expect(state.setEnvCalls).toEqual([
      { key: "COPILLM_ALLOW_PLAINTEXT_CREDENTIALS", value: "1" }
    ]);
    expect(state.prints.some((line) => line.includes("Credentials stored via credentials file"))).toBe(true);
  });

  it("does not invoke the fallback choose-prompt when the initial save succeeds", async () => {
    const { deps } = buildDeps({
      saveStoredCredential: vi.fn(async () => "file" as const)
    });
    await ensureAuthenticatedInteractive(deps);
    expect(deps.choose).not.toHaveBeenCalled();
    expect(deps.setEnv).not.toHaveBeenCalled();
  });
});
