import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit test for PR 2 / Fix 2: `models list` and `models select` must not
 * construct a `CopilotTokenManager` or call `ensureToken()`. The previous
 * code did so, then immediately discarded the bearer and passed the raw
 * OAuth token to `listModels` — pure ceremony, but every call was another
 * chance to throw `Copilot token exchange failed (401)` at the user.
 *
 * Regression guard: if a future edit re-introduces the dead exchange, the
 * `ensureTokenSpy` will be called and these tests will fail.
 */

vi.mock("@napi-rs/keyring", () => ({ AsyncEntry: null, default: null }));

const ensureTokenSpy = vi.fn();
const tokenManagerCtorSpy = vi.fn();

vi.mock("../../../src/auth/copilotToken.js", () => {
  // Spy-instrumented FakeCopilotTokenManager. If `models.ts` ever calls
  // `new CopilotTokenManager(...)` again, tokenManagerCtorSpy will record
  // it; if it then calls `.ensureToken()`, ensureTokenSpy records that too.
  class FakeCopilotTokenManager {
    public constructor(token: string) {
      tokenManagerCtorSpy(token);
    }
    public async ensureToken(): Promise<string> {
      return ensureTokenSpy();
    }
  }
  return { CopilotTokenManager: FakeCopilotTokenManager };
});

vi.mock("../../../src/auth/credentials.js", () => ({
  loadStoredCredential: vi.fn(async () => ({
    token: "ghu_test_token",
    accountType: "individual",
    source: "session"
  }))
}));

vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    preferredPort: 4141,
    requireCallerSecret: false,
    selectedModels: [],
    accountType: "individual"
  })),
  saveConfig: vi.fn()
}));

const listModelsMock = vi.fn();
vi.mock("../../../src/models/discovery.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/models/discovery.js")>(
    "../../../src/models/discovery.js"
  );
  return {
    ...actual,
    listModels: (...args: unknown[]) => listModelsMock(...args)
  };
});

beforeEach(() => {
  ensureTokenSpy.mockReset();
  tokenManagerCtorSpy.mockReset();
  ensureTokenSpy.mockResolvedValue("never-used-bearer");
  listModelsMock.mockReset();
  listModelsMock.mockResolvedValue({
    models: [{ id: "fake-model-a" }, { id: "fake-model-b" }],
    source: "live",
    stale: false,
    cacheAgeSeconds: 0,
    warning: null
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runModelsCommand(args: string[]): Promise<{ stdout: string; exitCode: null | number }> {
  // Capture stdout writes without polluting the test reporter.
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: typeof process.stdout.write }).write = ((
    chunk: string | Uint8Array
  ) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  let exitCode: null | number = null;
  try {
    const { Command } = await import("commander");
    const { register } = await import("../../../src/cli/commands/models.js");
    const program = new Command();
    program.exitOverride();
    register(program);
    await program.parseAsync(["node", "copillm", ...args]);
  } catch (err) {
    // Commander throws CommanderError on action failures when exitOverride is on.
    const maybeErr = err as { exitCode?: number; code?: string };
    exitCode = maybeErr.exitCode ?? 1;
  } finally {
    (process.stdout as { write: typeof process.stdout.write }).write = originalWrite;
  }

  return { stdout: writes.join(""), exitCode };
}

describe("models list — no dead token exchange (Fix 2 regression guard)", () => {
  it("does NOT construct a CopilotTokenManager or call ensureToken()", async () => {
    await runModelsCommand(["models", "list", "--json"]);
    expect(tokenManagerCtorSpy).not.toHaveBeenCalled();
    expect(ensureTokenSpy).not.toHaveBeenCalled();
    expect(listModelsMock).toHaveBeenCalledTimes(1);
  });

  it("succeeds even when ensureToken() would have thrown — proves the call site is truly removed", async () => {
    ensureTokenSpy.mockRejectedValue(new Error("Copilot token exchange failed (401)"));
    const result = await runModelsCommand(["models", "list", "--json"]);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain("fake-model-a");
  });
});

describe("models select — no dead token exchange (Fix 2 regression guard)", () => {
  it("does NOT construct a CopilotTokenManager or call ensureToken()", async () => {
    await runModelsCommand(["models", "select", "--models", "fake-model-a"]);
    expect(tokenManagerCtorSpy).not.toHaveBeenCalled();
    expect(ensureTokenSpy).not.toHaveBeenCalled();
    expect(listModelsMock).toHaveBeenCalledTimes(1);
  });

  it("succeeds even when ensureToken() would have thrown", async () => {
    ensureTokenSpy.mockRejectedValue(new Error("Copilot token exchange failed (401)"));
    const result = await runModelsCommand(["models", "select", "--models", "fake-model-a"]);
    expect(result.exitCode).toBeNull();
    expect(result.stdout.toLowerCase()).toContain("selected");
  });
});
