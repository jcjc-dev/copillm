import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PR E — accountManager coordination over the accounts index + credential
 * store. Runs against the in-memory session backend (forced) so no keychain
 * is needed.
 */

let tmpHome: string;
let originalHome: string | undefined;
let originalForceSession: string | undefined;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-acctmgr-"));
  originalHome = process.env.COPILLM_HOME;
  originalForceSession = process.env.COPILLM_FORCE_SESSION_BACKEND;
  process.env.COPILLM_HOME = tmpHome;
  process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  const creds = await import("../../../src/auth/credentials.js");
  creds.__resetSessionCredentialForTests();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.COPILLM_HOME;
  else process.env.COPILLM_HOME = originalHome;
  if (originalForceSession === undefined) delete process.env.COPILLM_FORCE_SESSION_BACKEND;
  else process.env.COPILLM_FORCE_SESSION_BACKEND = originalForceSession;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("accountManager.addAccount", () => {
  it("makes the first account the default with legacy storage", async () => {
    const { addAccount } = await import("../../../src/auth/accountManager.js");
    const r = await addAccount({ id: "octocat", accountType: "individual", token: "tok-1", mode: "session" });
    expect(r).toMatchObject({ id: "octocat", storage: "legacy", isDefault: true });
  });

  it("gives subsequent accounts namespaced storage and keeps the original default", async () => {
    const { addAccount } = await import("../../../src/auth/accountManager.js");
    await addAccount({ id: "octocat", accountType: "individual", token: "tok-1", mode: "session" });
    const r = await addAccount({ id: "work", accountType: "business", token: "tok-2", mode: "session" });
    expect(r).toMatchObject({ id: "work", storage: "namespaced", isDefault: false });

    const { getDefaultAccountId, listAccounts } = await import("../../../src/auth/accounts.js");
    expect(getDefaultAccountId()).toBe("octocat");
    expect(listAccounts().map((a) => a.id).sort()).toEqual(["octocat", "work"]);
  });

  it("stores each account's token independently in its own backend slot", async () => {
    const { addAccount } = await import("../../../src/auth/accountManager.js");
    const { loadStoredCredentialForAccount } = await import("../../../src/auth/credentials.js");
    await addAccount({ id: "octocat", accountType: "individual", token: "tok-1", mode: "session" });
    await addAccount({ id: "work", accountType: "business", token: "tok-2", mode: "session" });
    expect((await loadStoredCredentialForAccount("octocat"))?.token).toBe("tok-1");
    expect((await loadStoredCredentialForAccount("work"))?.token).toBe("tok-2");
  });

  it("makeDefault promotes an existing account without moving tokens", async () => {
    const { addAccount } = await import("../../../src/auth/accountManager.js");
    await addAccount({ id: "octocat", accountType: "individual", token: "tok-1", mode: "session" });
    const r = await addAccount({ id: "work", accountType: "business", token: "tok-2", makeDefault: true, mode: "session" });
    expect(r.isDefault).toBe(true);
    const { getDefaultAccountId } = await import("../../../src/auth/accounts.js");
    expect(getDefaultAccountId()).toBe("work");
  });
});

describe("accountManager listing + removal + switch", () => {
  it("lists accounts with default marker and stored state", async () => {
    const { addAccount, listAccountsDetailed } = await import("../../../src/auth/accountManager.js");
    await addAccount({ id: "octocat", accountType: "individual", token: "tok-1", mode: "session" });
    await addAccount({ id: "work", accountType: "business", token: "tok-2", mode: "session" });
    const listing = await listAccountsDetailed();
    expect(listing.hasIndex).toBe(true);
    expect(listing.defaultAccount).toBe("octocat");
    const work = listing.accounts.find((a) => a.id === "work");
    expect(work).toMatchObject({ accountType: "business", storage: "namespaced", isDefault: false, stored: true, backend: "session" });
  });

  it("removeAccountAndCredential reassigns the default and clears the token", async () => {
    const { addAccount, removeAccountAndCredential } = await import("../../../src/auth/accountManager.js");
    const { loadStoredCredentialForAccount } = await import("../../../src/auth/credentials.js");
    await addAccount({ id: "octocat", accountType: "individual", token: "tok-1", mode: "session" });
    await addAccount({ id: "work", accountType: "business", token: "tok-2", mode: "session" });
    const r = await removeAccountAndCredential("octocat");
    expect(r.removed).toBe(true);
    expect(r.newDefault).toBe("work");
    expect(await loadStoredCredentialForAccount("octocat")).toBeNull();
  });

  it("removeAllAccounts clears every token and deletes the index", async () => {
    const { addAccount, removeAllAccounts } = await import("../../../src/auth/accountManager.js");
    const { readAccountsIndex } = await import("../../../src/auth/accounts.js");
    await addAccount({ id: "octocat", accountType: "individual", token: "tok-1", mode: "session" });
    await addAccount({ id: "work", accountType: "business", token: "tok-2", mode: "session" });
    const r = await removeAllAccounts();
    expect(r.indexDeleted).toBe(true);
    expect(r.clearedCount).toBe(2);
    expect(readAccountsIndex()).toBeNull();
  });

  it("switchDefaultAccount throws for an unknown account", async () => {
    const { addAccount, switchDefaultAccount } = await import("../../../src/auth/accountManager.js");
    const { UnknownAccountError } = await import("../../../src/auth/accounts.js");
    await addAccount({ id: "octocat", accountType: "individual", token: "tok-1", mode: "session" });
    expect(() => switchDefaultAccount("ghost")).toThrow(UnknownAccountError);
  });
});
