import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CopilotTokenManager } from "../../../src/auth/copilotToken.js";

/**
 * PR D — DaemonAccountResolver. Resolves a request's target account into the
 * GitHub token + bearer manager + plan type + model-cache id, lazily building
 * (and caching) a bearer manager per named account.
 */

let tmpHome: string;
let originalHome: string | undefined;
let originalForceSession: string | undefined;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-resolver-"));
  originalHome = process.env.COPILLM_HOME;
  originalForceSession = process.env.COPILLM_FORCE_SESSION_BACKEND;
  process.env.COPILLM_HOME = tmpHome;
  process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  const creds = await import("../../../src/auth/credentials.js");
  creds.__resetSessionCredentialForTests();
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.COPILLM_HOME;
  } else {
    process.env.COPILLM_HOME = originalHome;
  }
  if (originalForceSession === undefined) {
    delete process.env.COPILLM_FORCE_SESSION_BACKEND;
  } else {
    process.env.COPILLM_FORCE_SESSION_BACKEND = originalForceSession;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakeManager(token: string): CopilotTokenManager {
  // A real manager is fine — resolution never triggers a network exchange.
  return new CopilotTokenManager(token);
}

describe("DaemonAccountResolver", () => {
  it("returns the default account for the default id without hitting storage", async () => {
    const { DaemonAccountResolver } = await import("../../../src/server/accountResolver.js");
    const def = {
      accountId: "primary",
      githubToken: "tok-primary",
      tokenManager: fakeManager("tok-primary"),
      accountType: "individual" as const,
      cacheId: undefined
    };
    const create = vi.fn((t: string) => fakeManager(t));
    const resolver = new DaemonAccountResolver({ default: def, createTokenManager: create });

    expect(await resolver.resolveById("primary")).toBe(def);
    expect(create).not.toHaveBeenCalled();
  });

  it("lazily resolves a namespaced account and caches the manager", async () => {
    const { saveStoredCredentialForAccount } = await import("../../../src/auth/credentials.js");
    const { upsertAccount } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "work", accountType: "business", storage: "namespaced", addedAt: new Date().toISOString() });
    await saveStoredCredentialForAccount("work", "tok-work", "business", { mode: "session" });

    const { DaemonAccountResolver } = await import("../../../src/server/accountResolver.js");
    const create = vi.fn((t: string) => fakeManager(t));
    const resolver = new DaemonAccountResolver({
      default: { accountId: null, githubToken: "tok-d", tokenManager: fakeManager("tok-d"), accountType: "individual", cacheId: undefined },
      createTokenManager: create
    });

    const first = await resolver.resolveById("work");
    expect(first).not.toBeNull();
    expect(first?.githubToken).toBe("tok-work");
    expect(first?.accountType).toBe("business");
    // Namespaced account → its own model cache id.
    expect(first?.cacheId).toBe("work");
    expect(create).toHaveBeenCalledTimes(1);

    // Second resolve is cached — no new manager built.
    const second = await resolver.resolveById("work");
    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);

    expect(resolver.describe()).toEqual({ defaultAccountId: null, activeAccountIds: ["work"] });
  });

  it("uses the legacy cache id (undefined) for a legacy-storage account", async () => {
    const { saveStoredCredentialForAccount } = await import("../../../src/auth/credentials.js");
    const { upsertAccount } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: new Date().toISOString() });
    await saveStoredCredentialForAccount("octocat", "tok-oct", "individual", { mode: "session" });

    const { DaemonAccountResolver } = await import("../../../src/server/accountResolver.js");
    const resolver = new DaemonAccountResolver({
      default: { accountId: null, githubToken: "tok-d", tokenManager: fakeManager("tok-d"), accountType: "individual", cacheId: undefined },
      createTokenManager: (t) => fakeManager(t)
    });

    const resolved = await resolver.resolveById("octocat");
    expect(resolved?.cacheId).toBeUndefined();
  });

  it("returns null for an account with no stored credential", async () => {
    const { DaemonAccountResolver } = await import("../../../src/server/accountResolver.js");
    const resolver = new DaemonAccountResolver({
      default: { accountId: null, githubToken: "tok-d", tokenManager: fakeManager("tok-d"), accountType: "individual", cacheId: undefined },
      createTokenManager: (t) => fakeManager(t)
    });
    expect(await resolver.resolveById("ghost")).toBeNull();
  });
});

describe("singleAccountResolver", () => {
  it("knows only the default account; any other id resolves to null", async () => {
    const { singleAccountResolver } = await import("../../../src/server/accountResolver.js");
    const resolver = singleAccountResolver({
      tokenManager: fakeManager("tok"),
      githubToken: "tok",
      accountType: "individual"
    });
    expect(resolver.default.accountId).toBeNull();
    expect(await resolver.resolveById("anything")).toBeNull();
    expect(resolver.describe()).toEqual({ defaultAccountId: null, activeAccountIds: [] });
  });
});
