import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@napi-rs/keyring", () => ({ AsyncEntry: null, default: null }));

let tmpHome: string;
let originalHome: string | undefined;
let originalForceSession: string | undefined;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-session-"));
  originalHome = process.env.COPILLM_HOME;
  originalForceSession = process.env.COPILLM_FORCE_SESSION_BACKEND;
  process.env.COPILLM_HOME = tmpHome;
  delete process.env.COPILLM_FORCE_SESSION_BACKEND;
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

describe("session credential backend", () => {
  it("save → load round-trips a token in memory", async () => {
    const { loadStoredCredential, saveStoredCredential } = await import(
      "../../../src/auth/credentials.js"
    );
    const backend = await saveStoredCredential("tok-abc", "business", { mode: "session" });
    expect(backend).toBe("session");
    const loaded = await loadStoredCredential();
    expect(loaded).toEqual({ token: "tok-abc", accountType: "business", source: "session" });
  });

  it("does NOT write a credentials file when mode is session", async () => {
    const { saveStoredCredential } = await import("../../../src/auth/credentials.js");
    await saveStoredCredential("tok-abc", "individual", { mode: "session" });
    expect(fs.existsSync(path.join(tmpHome, "credentials.json"))).toBe(false);
  });

  it("session credential overrides an on-disk plaintext file", async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, "credentials.json"),
      JSON.stringify(
        { version: 1, github_token: "tok-file", account_type: "individual", saved_at: new Date().toISOString() },
        null,
        2
      ),
      { mode: 0o600 }
    );
    const { loadStoredCredential, saveStoredCredential } = await import(
      "../../../src/auth/credentials.js"
    );
    await saveStoredCredential("tok-session", "individual", { mode: "session" });
    const loaded = await loadStoredCredential();
    expect(loaded?.source).toBe("session");
    expect(loaded?.token).toBe("tok-session");
  });

  it("clearStoredCredential drops the in-memory session token", async () => {
    const { clearStoredCredential, loadStoredCredential, saveStoredCredential } = await import(
      "../../../src/auth/credentials.js"
    );
    await saveStoredCredential("tok-clear-me", "individual", { mode: "session" });
    const cleared = await clearStoredCredential();
    expect(cleared).toEqual({ backend: "session", removed: true });
    const loaded = await loadStoredCredential();
    expect(loaded).toBeNull();
  });

  it("COPILLM_FORCE_SESSION_BACKEND=1 disables the plaintext fallback gate", async () => {
    process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
    const { saveStoredCredential } = await import("../../../src/auth/credentials.js");
    // Default save mode ("auto") with no keychain and no file should hit the
    // plaintext-fallback branch. With the gate disabled by force-session, the
    // call must throw rather than silently writing plaintext.
    await expect(
      saveStoredCredential("tok-should-not-be-written", "individual")
    ).rejects.toThrow(/keychain backend unavailable/i);
    expect(fs.existsSync(path.join(tmpHome, "credentials.json"))).toBe(false);
  });
});
