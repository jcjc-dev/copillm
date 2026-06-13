import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * In-memory fake OS keychain so multi-account storage can be exercised on CI
 * machines without a real keyring. Keyed by `${service}\u0000${account}` so
 * each namespaced account string maps to its own slot.
 */
const keychain = new Map<string, string>();
function slot(service: string, account: string): string {
  return `${service}\u0000${account}`;
}

vi.mock("@napi-rs/keyring", () => {
  class FakeAsyncEntry {
    public constructor(private readonly service: string, private readonly account: string) {}
    async getPassword(): Promise<string | null> {
      return keychain.get(slot(this.service, this.account)) ?? null;
    }
    async setPassword(password: string): Promise<void> {
      keychain.set(slot(this.service, this.account), password);
    }
    async deletePassword(): Promise<boolean> {
      return keychain.delete(slot(this.service, this.account));
    }
  }
  return { AsyncEntry: FakeAsyncEntry, default: { AsyncEntry: FakeAsyncEntry } };
});

let tmpHome: string;
let originalHome: string | undefined;
let originalForceSession: string | undefined;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-cred-acct-"));
  originalHome = process.env.COPILLM_HOME;
  originalForceSession = process.env.COPILLM_FORCE_SESSION_BACKEND;
  process.env.COPILLM_HOME = tmpHome;
  delete process.env.COPILLM_FORCE_SESSION_BACKEND;
  keychain.clear();
  const mod = await import("../../../src/auth/credentials.js");
  mod.__resetSessionCredentialForTests();
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
});

function writeLegacyFile(token: string, accountType: "individual" | "business" | "enterprise" = "individual"): void {
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, "credentials.json"),
    JSON.stringify({ version: 1, github_token: token, account_type: accountType, saved_at: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
}

describe("credentials — backward compatibility (no accounts index)", () => {
  it("loads a pre-existing legacy credentials.json as the default account", async () => {
    writeLegacyFile("tok-legacy", "business");
    const { loadStoredCredential } = await import("../../../src/auth/credentials.js");
    const loaded = await loadStoredCredential();
    expect(loaded).toEqual({ token: "tok-legacy", accountType: "business", source: "file" });
  });

  it("inspecting/loading the default never creates an accounts.json", async () => {
    writeLegacyFile("tok-legacy");
    const { loadStoredCredential, inspectStoredCredential } = await import("../../../src/auth/credentials.js");
    await inspectStoredCredential();
    await loadStoredCredential();
    expect(fs.existsSync(path.join(tmpHome, "accounts.json"))).toBe(false);
  });

  it("reads a pre-existing legacy credential from the keychain as the default", async () => {
    keychain.set(slot("copillm", "github-oauth-token"), "tok-keychain-legacy");
    const { loadStoredCredential, inspectStoredCredential } = await import("../../../src/auth/credentials.js");
    expect(await inspectStoredCredential()).toEqual({ stored: true, backend: "keyring" });
    const loaded = await loadStoredCredential();
    expect(loaded?.token).toBe("tok-keychain-legacy");
    expect(loaded?.source).toBe("keyring");
  });
});

describe("credentials — account-scoped storage", () => {
  it("round-trips independent tokens per account via the keychain", async () => {
    const { saveStoredCredentialForAccount, loadStoredCredentialForAccount } = await import(
      "../../../src/auth/credentials.js"
    );
    await saveStoredCredentialForAccount("octocat", "tok-a", "individual");
    await saveStoredCredentialForAccount("octocat-work", "tok-b", "business");

    const a = await loadStoredCredentialForAccount("octocat");
    const b = await loadStoredCredentialForAccount("octocat-work");
    expect(a?.token).toBe("tok-a");
    expect(b?.token).toBe("tok-b");
    // Distinct keychain slots — namespaced by id.
    expect(keychain.has(slot("copillm", "github-oauth-token:octocat"))).toBe(true);
    expect(keychain.has(slot("copillm", "github-oauth-token:octocat-work"))).toBe(true);
  });

  it("clearing one account leaves the other intact", async () => {
    const { saveStoredCredentialForAccount, clearStoredCredentialForAccount, loadStoredCredentialForAccount } =
      await import("../../../src/auth/credentials.js");
    await saveStoredCredentialForAccount("octocat", "tok-a", "individual");
    await saveStoredCredentialForAccount("octocat-work", "tok-b", "business");
    await clearStoredCredentialForAccount("octocat");
    expect(await loadStoredCredentialForAccount("octocat")).toBeNull();
    expect((await loadStoredCredentialForAccount("octocat-work"))?.token).toBe("tok-b");
  });

  it("session backend isolates tokens per account", async () => {
    const { saveStoredCredentialForAccount, loadStoredCredentialForAccount } = await import(
      "../../../src/auth/credentials.js"
    );
    await saveStoredCredentialForAccount("a", "tok-a", "individual", { mode: "session" });
    await saveStoredCredentialForAccount("b", "tok-b", "individual", { mode: "session" });
    expect((await loadStoredCredentialForAccount("a"))?.token).toBe("tok-a");
    expect((await loadStoredCredentialForAccount("b"))?.token).toBe("tok-b");
    expect((await loadStoredCredentialForAccount("a"))?.source).toBe("session");
  });

  it("named account file fallback writes credentials.<id>.json, not credentials.json", async () => {
    process.env.COPILLM_ALLOW_PLAINTEXT_CREDENTIALS = "1";
    try {
      // No keychain available for this test: force the plaintext path by making
      // the keychain reject. Simplest: pre-create a namespaced file so the
      // file branch is taken on save.
      fs.mkdirSync(tmpHome, { recursive: true });
      fs.writeFileSync(
        path.join(tmpHome, "credentials.work.json"),
        JSON.stringify({ version: 1, github_token: "old", account_type: "business", saved_at: new Date().toISOString() }, null, 2),
        { mode: 0o600 }
      );
      const { saveStoredCredentialForAccount } = await import("../../../src/auth/credentials.js");
      await saveStoredCredentialForAccount("work", "tok-work", "business");
      const raw = JSON.parse(fs.readFileSync(path.join(tmpHome, "credentials.work.json"), "utf8")) as {
        github_token: string;
      };
      expect(raw.github_token).toBe("tok-work");
      expect(fs.existsSync(path.join(tmpHome, "credentials.json"))).toBe(false);
    } finally {
      delete process.env.COPILLM_ALLOW_PLAINTEXT_CREDENTIALS;
    }
  });
});

describe("credentials — default resolution with an index", () => {
  it("registerExistingCredentialAsDefault records storage=legacy without moving the token", async () => {
    writeLegacyFile("tok-legacy", "business");
    const { registerExistingCredentialAsDefault, loadStoredCredential } = await import(
      "../../../src/auth/credentials.js"
    );
    const record = registerExistingCredentialAsDefault("octocat", "business");
    expect(record).toMatchObject({ id: "octocat", storage: "legacy", accountType: "business" });
    // The token did NOT move — it's still in credentials.json and the default
    // load returns it unchanged.
    expect(fs.existsSync(path.join(tmpHome, "credentials.json"))).toBe(true);
    expect((await loadStoredCredential())?.token).toBe("tok-legacy");
  });

  it("registerExistingCredentialAsDefault is idempotent", async () => {
    writeLegacyFile("tok-legacy");
    const { registerExistingCredentialAsDefault } = await import("../../../src/auth/credentials.js");
    const first = registerExistingCredentialAsDefault("octocat", "individual");
    const second = registerExistingCredentialAsDefault("octocat", "individual");
    expect(second.id).toBe(first.id);
    const { listAccounts } = await import("../../../src/auth/accounts.js");
    expect(listAccounts()).toHaveLength(1);
  });

  it("default surface follows the index default; legacy account keeps legacy keys", async () => {
    writeLegacyFile("tok-legacy", "individual");
    const {
      registerExistingCredentialAsDefault,
      saveStoredCredentialForAccount,
      loadStoredCredential,
      loadStoredCredentialForAccount
    } = await import("../../../src/auth/credentials.js");
    const { setDefaultAccountId, upsertAccount } = await import("../../../src/auth/accounts.js");

    registerExistingCredentialAsDefault("octocat", "individual");
    upsertAccount({ id: "work", accountType: "business", storage: "namespaced", addedAt: new Date().toISOString() });
    await saveStoredCredentialForAccount("work", "tok-work", "business");

    // Default still points at the legacy account → legacy file.
    expect((await loadStoredCredential())?.token).toBe("tok-legacy");
    // Addressing the legacy account by id still resolves to legacy storage.
    expect((await loadStoredCredentialForAccount("octocat"))?.token).toBe("tok-legacy");
    // The named account is independent.
    expect((await loadStoredCredentialForAccount("work"))?.token).toBe("tok-work");

    // Switch the default to the named account → default surface follows.
    setDefaultAccountId("work");
    expect((await loadStoredCredential())?.token).toBe("tok-work");
  });

  it("loadStoredCredentialForAccount enriches keyring accountType from the index", async () => {
    // Keychain can't store the account type; the index can. A business account
    // stored only in the keychain should still report accountType "business".
    keychain.set(slot("copillm", "github-oauth-token:work"), "tok-work");
    const { upsertAccount } = await import("../../../src/auth/accounts.js");
    upsertAccount({ id: "work", accountType: "business", storage: "namespaced", addedAt: new Date().toISOString() });
    const { loadStoredCredentialForAccount } = await import("../../../src/auth/credentials.js");
    const loaded = await loadStoredCredentialForAccount("work");
    expect(loaded).toEqual({ token: "tok-work", accountType: "business", source: "keyring" });
  });
});
