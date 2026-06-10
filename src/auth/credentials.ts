import fs from "node:fs";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AccountType, StoredCredentialFile } from "../types/index.js";
import { ensureAppHome } from "../config/config.js";
import { credentialsPath, credentialsReadPath } from "../config/home.js";
import { writeFileSecureAtomic } from "../config/fsSecurity.js";

const SERVICE = "copillm";
const ACCOUNT = "github-oauth-token";

interface KeyringLike {
  getPassword(service: string, account: string): Promise<null | string>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export type CredentialBackend = "file" | "keyring" | "session";

export type SaveMode = "auto" | "session";

interface KeyringResolution {
  keyring: null | KeyringLike;
  reason: null | string;
}

const FileCredentialSchema = z.object({
  version: z.literal(1),
  github_token: z.string().min(1),
  account_type: z.enum(["individual", "business", "enterprise"]),
  saved_at: z.string().min(1)
});

// Module-level in-memory credential. Only populated when SaveMode === "session".
// Never persisted; cleared on clearStoredCredential() and on process exit.
let sessionCredential: null | { token: string; accountType: AccountType } = null;

function forceSessionBackend(): boolean {
  return process.env.COPILLM_FORCE_SESSION_BACKEND === "1";
}

async function tryImportKeyring(): Promise<null | KeyringLike> {
  if (forceSessionBackend()) {
    return null;
  }
  try {
    const mod = (await import("@napi-rs/keyring")) as unknown as {
      AsyncEntry?: new (service: string, account: string) => {
        getPassword(): Promise<string | undefined | null>;
        setPassword(password: string): Promise<void>;
        deletePassword(): Promise<unknown>;
      };
      default?: { AsyncEntry?: unknown } | null;
    };
    // Test seam: mocks can return `null` or `{ default: null }` to simulate an
    // unavailable backend without throwing from the vi.mock factory (which
    // confuses vitest's hoisting and our isMissingKeyringError check).
    if (!mod) {
      return null;
    }
    const AsyncEntry =
      mod.AsyncEntry ?? (mod.default && typeof mod.default === "object" ? (mod.default as { AsyncEntry?: typeof mod.AsyncEntry }).AsyncEntry : undefined);
    if (typeof AsyncEntry !== "function") {
      return null;
    }
    return {
      async getPassword(service, account) {
        const entry = new AsyncEntry(service, account);
        try {
          const value = await entry.getPassword();
          return value ?? null;
        } catch (error) {
          if (isNoEntryError(error)) {
            return null;
          }
          throw error;
        }
      },
      async setPassword(service, account, password) {
        const entry = new AsyncEntry(service, account);
        await entry.setPassword(password);
      },
      async deletePassword(service, account) {
        const entry = new AsyncEntry(service, account);
        try {
          await entry.deletePassword();
          return true;
        } catch (error) {
          if (isNoEntryError(error)) {
            return false;
          }
          throw error;
        }
      }
    };
  } catch (error) {
    if (isMissingKeyringError(error)) {
      return null;
    }
    if (error instanceof Error) {
      throw new Error(`Failed to initialize OS keychain backend: ${error.message}`);
    }
    throw new Error("Failed to initialize OS keychain backend: unknown error");
  }
}

// keyring-rs returns a "NoEntry" error when an item doesn't exist. Map that to
// null/false to preserve the keytar-style "missing is not an error" semantics
// that the rest of credentials.ts is built around.
function isNoEntryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("no matching entry") || message.includes("no entry") || message.includes("noentry");
}

async function resolveKeyring(): Promise<KeyringResolution> {
  if (forceSessionBackend()) {
    return { keyring: null, reason: "forced_session_backend" };
  }
  const keyring = await tryImportKeyring();
  if (keyring) {
    return { keyring, reason: null };
  }
  return { keyring: null, reason: "keyring module is unavailable on this machine" };
}

function parseCredentialFile(): { token: string; accountType: AccountType } {
  const path = credentialsReadPath();
  const raw = readFileSync(path, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Credential file exists but contains invalid JSON at ${path}: ${error.message}`);
    }
    throw new Error(`Credential file exists but contains invalid JSON at ${path}.`);
  }

  try {
    const parsed = FileCredentialSchema.parse(parsedJson);
    return { token: parsed.github_token, accountType: parsed.account_type };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Credential file exists but is invalid at ${path}: ${error.message}`);
    }
    throw new Error(`Credential file exists but is invalid at ${path}.`);
  }
}

function writeCredentialFile(token: string, accountType: AccountType): void {
  ensureAppHome();
  const payload: StoredCredentialFile = {
    version: 1,
    github_token: token,
    account_type: accountType,
    saved_at: new Date().toISOString()
  };
  writeFileSecureAtomic(credentialsPath(), JSON.stringify(payload, null, 2), 0o600);
}

function canUsePlaintextFallback(): boolean {
  if (forceSessionBackend()) {
    return false;
  }
  return process.stdin.isTTY || process.env.COPILLM_ALLOW_PLAINTEXT_CREDENTIALS === "1";
}

function isMissingKeyringError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("cannot find package '@napi-rs/keyring") ||
    message.includes("cannot find module '@napi-rs/keyring") ||
    message.includes("module not found")
  );
}

/**
 * Returns whether a credential is present and which backend holds it.
 * Never returns the token itself — callers that need to introspect should use
 * this helper to avoid accidentally pulling the secret into a code path that
 * might log or print it.
 */
export async function inspectStoredCredential(): Promise<{ stored: boolean; backend: null | CredentialBackend }> {
  if (sessionCredential) {
    return { stored: true, backend: "session" };
  }
  if (fs.existsSync(credentialsReadPath())) {
    return { stored: true, backend: "file" };
  }
  const { keyring } = await resolveKeyring();
  if (!keyring) {
    return { stored: false, backend: null };
  }
  try {
    const token = await keyring.getPassword(SERVICE, ACCOUNT);
    if (token) {
      return { stored: true, backend: "keyring" };
    }
    return { stored: false, backend: null };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to read token from OS keychain: ${error.message}`);
    }
    throw new Error("Failed to read token from OS keychain.");
  }
}

export interface StoredCredential {
  token: string;
  accountType: AccountType;
  source: CredentialBackend;
}

export async function loadStoredCredential(): Promise<null | StoredCredential> {
  if (sessionCredential) {
    return { token: sessionCredential.token, accountType: sessionCredential.accountType, source: "session" };
  }
  if (fs.existsSync(credentialsReadPath())) {
    const parsed = parseCredentialFile();
    return { token: parsed.token, accountType: parsed.accountType, source: "file" };
  }

  const { keyring } = await resolveKeyring();
  if (!keyring) {
    return null;
  }

  let token: null | string;
  try {
    token = await keyring.getPassword(SERVICE, ACCOUNT);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to read token from OS keychain: ${error.message}`);
    }
    throw new Error("Failed to read token from OS keychain.");
  }
  if (!token) {
    return null;
  }
  return { token, accountType: "individual", source: "keyring" };
}

export async function saveStoredCredential(
  token: string,
  accountType: AccountType,
  options: { mode?: SaveMode } = {}
): Promise<CredentialBackend> {
  const mode: SaveMode = options.mode ?? "auto";

  if (mode === "session") {
    sessionCredential = { token, accountType };
    return "session";
  }

  if (fs.existsSync(credentialsReadPath())) {
    parseCredentialFile();
    writeCredentialFile(token, accountType);
    return "file";
  }

  const { keyring, reason } = await resolveKeyring();
  if (keyring) {
    try {
      await keyring.setPassword(SERVICE, ACCOUNT, token);
      return "keyring";
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to write token to OS keychain: ${error.message}`);
      }
      throw new Error("Failed to write token to OS keychain.");
    }
  }

  if (!canUsePlaintextFallback()) {
    throw new Error(
      `OS keychain backend unavailable (${reason ?? "unknown reason"}). Plaintext fallback is disabled in non-interactive mode; set COPILLM_ALLOW_PLAINTEXT_CREDENTIALS=1 to allow it.`
    );
  }
  writeCredentialFile(token, accountType);
  return "file";
}

export async function clearStoredCredential(): Promise<{ backend: CredentialBackend; removed: boolean }> {
  // Always clear in-memory session token first; it shadows other backends.
  const hadSession = sessionCredential !== null;
  sessionCredential = null;

  const readablePath = credentialsReadPath();
  const canonicalPath = credentialsPath();
  if (fs.existsSync(readablePath)) {
    fs.unlinkSync(readablePath);
    if (readablePath !== canonicalPath && fs.existsSync(canonicalPath)) {
      fs.unlinkSync(canonicalPath);
    }
    return { backend: "file", removed: true };
  }

  const { keyring, reason } = await resolveKeyring();
  if (keyring) {
    try {
      const removed = await keyring.deletePassword(SERVICE, ACCOUNT);
      return { backend: "keyring", removed: removed || hadSession };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to clear token from OS keychain: ${error.message}`);
      }
      throw new Error("Failed to clear token from OS keychain.");
    }
  }

  if (hadSession) {
    return { backend: "session", removed: true };
  }
  throw new Error(
    `No credential backend available to clear credentials (${reason ?? "unknown reason"}).`
  );
}

// Test seam: forcibly clear the in-memory session credential. Not exported via
// the package surface for end users — only used by unit tests.
export function __resetSessionCredentialForTests(): void {
  sessionCredential = null;
}
