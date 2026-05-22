import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Default mock: keytar exists but exposes no callable backend. credentials.ts
// will cast `mod.default` as KeytarLike, get `null`, and fall through to the
// "unavailable" path — matching real-world behaviour on machines without a
// usable keychain backend. Returning a stub object (rather than throwing in
// the factory) keeps vitest's hoisting happy and avoids the wrapped-error
// pattern that confuses isMissingKeytarError.
vi.mock("keytar", () => ({ default: null }));

let tmpHome: string;
let originalHome: string | undefined;
let originalForceSession: string | undefined;
let originalAllowPlaintext: string | undefined;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-creds-"));
  originalHome = process.env.COPILLM_HOME;
  originalForceSession = process.env.COPILLM_FORCE_SESSION_BACKEND;
  originalAllowPlaintext = process.env.COPILLM_ALLOW_PLAINTEXT_CREDENTIALS;
  process.env.COPILLM_HOME = tmpHome;
  delete process.env.COPILLM_FORCE_SESSION_BACKEND;
  delete process.env.COPILLM_ALLOW_PLAINTEXT_CREDENTIALS;
  // Reset module state between tests so the in-memory session credential
  // doesn't leak across cases.
  const mod = await import("../src/auth/credentials.js");
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
  if (originalAllowPlaintext === undefined) {
    delete process.env.COPILLM_ALLOW_PLAINTEXT_CREDENTIALS;
  } else {
    process.env.COPILLM_ALLOW_PLAINTEXT_CREDENTIALS = originalAllowPlaintext;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("inspectStoredCredential", () => {
  it("reports stored: false when nothing is configured (no keytar, no file)", async () => {
    const { inspectStoredCredential } = await import("../src/auth/credentials.js");
    const result = await inspectStoredCredential();
    expect(result).toEqual({ stored: false, backend: null });
  });

  it("does NOT include the token in its return shape", async () => {
    const { inspectStoredCredential, saveStoredCredential } = await import(
      "../src/auth/credentials.js"
    );
    await saveStoredCredential("sk-test-shouldnt-leak-1234567890", "individual", { mode: "session" });
    const result = await inspectStoredCredential();
    // Spread into a plain object and verify the serialized form has no token.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-test-shouldnt-leak");
    expect(Object.keys(result).sort()).toEqual(["backend", "stored"]);
  });

  it("detects a session-only credential and returns backend: \"session\"", async () => {
    const { inspectStoredCredential, saveStoredCredential } = await import(
      "../src/auth/credentials.js"
    );
    await saveStoredCredential("tok-session", "individual", { mode: "session" });
    const result = await inspectStoredCredential();
    expect(result).toEqual({ stored: true, backend: "session" });
  });

  it("detects an existing plaintext credential file", async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    const credPath = path.join(tmpHome, "credentials.json");
    fs.writeFileSync(
      credPath,
      JSON.stringify(
        { version: 1, github_token: "tok-file", account_type: "individual", saved_at: new Date().toISOString() },
        null,
        2
      ),
      { mode: 0o600 }
    );
    const { inspectStoredCredential } = await import("../src/auth/credentials.js");
    const result = await inspectStoredCredential();
    expect(result).toEqual({ stored: true, backend: "file" });
  });

  it("session credential takes precedence over an on-disk file", async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    const credPath = path.join(tmpHome, "credentials.json");
    fs.writeFileSync(
      credPath,
      JSON.stringify(
        { version: 1, github_token: "tok-file", account_type: "individual", saved_at: new Date().toISOString() },
        null,
        2
      ),
      { mode: 0o600 }
    );
    const { inspectStoredCredential, saveStoredCredential } = await import(
      "../src/auth/credentials.js"
    );
    await saveStoredCredential("tok-session", "individual", { mode: "session" });
    const result = await inspectStoredCredential();
    expect(result).toEqual({ stored: true, backend: "session" });
  });

  it("respects COPILLM_FORCE_SESSION_BACKEND=1 by skipping keychain detection", async () => {
    process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
    const { inspectStoredCredential } = await import("../src/auth/credentials.js");
    // No file, no session credential, keychain forcibly skipped → nothing stored.
    const result = await inspectStoredCredential();
    expect(result).toEqual({ stored: false, backend: null });
  });
});
