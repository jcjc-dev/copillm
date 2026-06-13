import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-accounts-"));
  originalHome = process.env.COPILLM_HOME;
  process.env.COPILLM_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.COPILLM_HOME;
  } else {
    process.env.COPILLM_HOME = originalHome;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function indexPath(): string {
  return path.join(tmpHome, "accounts.json");
}

describe("accounts index", () => {
  it("returns null when no index exists (single-account install)", async () => {
    const { readAccountsIndex, listAccounts, getDefaultAccountId } = await import("../../../src/auth/accounts.js");
    expect(readAccountsIndex()).toBeNull();
    expect(listAccounts()).toEqual([]);
    expect(getDefaultAccountId()).toBeNull();
  });

  it("upsertAccount creates the index with the first account as default", async () => {
    const { upsertAccount, getDefaultAccountId } = await import("../../../src/auth/accounts.js");
    const index = upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    expect(index.defaultAccount).toBe("octocat");
    expect(index.accounts).toHaveLength(1);
    expect(getDefaultAccountId()).toBe("octocat");
    expect(fs.existsSync(indexPath())).toBe(true);
  });

  it("upsertAccount adds further accounts without changing the default", async () => {
    const { upsertAccount } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    const index = upsertAccount({ id: "octocat-work", accountType: "business", storage: "namespaced", addedAt: "2026-01-02T00:00:00.000Z" });
    expect(index.defaultAccount).toBe("octocat");
    expect(index.accounts.map((a) => a.id).sort()).toEqual(["octocat", "octocat-work"]);
  });

  it("upsertAccount replaces an existing record with the same id (no duplicate)", async () => {
    const { upsertAccount, findAccount } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    const index = upsertAccount({ id: "octocat", accountType: "enterprise", storage: "legacy", addedAt: "2026-02-02T00:00:00.000Z" });
    expect(index.accounts).toHaveLength(1);
    expect(findAccount("octocat")?.accountType).toBe("enterprise");
  });

  it("setDefaultAccountId points the default at an existing account", async () => {
    const { upsertAccount, setDefaultAccountId } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    upsertAccount({ id: "octocat-work", accountType: "business", storage: "namespaced", addedAt: "2026-01-02T00:00:00.000Z" });
    const index = setDefaultAccountId("octocat-work");
    expect(index.defaultAccount).toBe("octocat-work");
  });

  it("setDefaultAccountId throws UnknownAccountError for an unregistered id", async () => {
    const { upsertAccount, setDefaultAccountId, UnknownAccountError } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    expect(() => setDefaultAccountId("ghost")).toThrow(UnknownAccountError);
  });

  it("removeAccount reassigns the default when the default is removed", async () => {
    const { upsertAccount, removeAccount } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    upsertAccount({ id: "octocat-work", accountType: "business", storage: "namespaced", addedAt: "2026-01-02T00:00:00.000Z" });
    const index = removeAccount("octocat");
    expect(index?.accounts.map((a) => a.id)).toEqual(["octocat-work"]);
    expect(index?.defaultAccount).toBe("octocat-work");
  });

  it("removeAccount deletes the index entirely when the last account is removed", async () => {
    const { upsertAccount, removeAccount, readAccountsIndex } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    const index = removeAccount("octocat");
    expect(index).toBeNull();
    expect(fs.existsSync(indexPath())).toBe(false);
    expect(readAccountsIndex()).toBeNull();
  });

  it("writes the index with 0600 permissions", async () => {
    const { upsertAccount } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    if (process.platform !== "win32") {
      const mode = fs.statSync(indexPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("never stores a token in the index file", async () => {
    const { upsertAccount } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "octocat", accountType: "individual", storage: "legacy", addedAt: "2026-01-01T00:00:00.000Z" });
    const raw = fs.readFileSync(indexPath(), "utf8");
    expect(raw).not.toMatch(/token/i);
  });

  it("assertValidAccountId rejects path-unsafe ids", async () => {
    const { assertValidAccountId, InvalidAccountIdError } = await import("../../../src/auth/accounts.js");
    expect(() => assertValidAccountId("octocat")).not.toThrow();
    expect(() => assertValidAccountId("octocat-work")).not.toThrow();
    for (const bad of ["../escape", "a/b", "with space", "has:colon", "", ".dotstart"]) {
      expect(() => assertValidAccountId(bad), bad).toThrow(InvalidAccountIdError);
    }
  });

  it("throws on a corrupt index rather than silently dropping accounts", async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(indexPath(), "{ not valid json", { mode: 0o600 });
    const { readAccountsIndex } = await import("../../../src/auth/accounts.js");
    expect(() => readAccountsIndex()).toThrow(/invalid JSON/i);
  });

  it("throws when defaultAccount is not among the accounts", async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(
      indexPath(),
      JSON.stringify({ version: 1, defaultAccount: "ghost", accounts: [] }),
      { mode: 0o600 }
    );
    const { readAccountsIndex } = await import("../../../src/auth/accounts.js");
    expect(() => readAccountsIndex()).toThrow(/not present/i);
  });
});
