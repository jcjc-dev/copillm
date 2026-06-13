import fs from "node:fs";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AccountType, StoredCredentialFile } from "../types/index.js";
import { ensureAppHome } from "../config/config.js";
import {
  accountCredentialsPath,
  accountCredentialsReadPath,
  credentialsPath,
  credentialsReadPath
} from "../config/home.js";
import { writeFileSecureAtomic } from "../config/fsSecurity.js";
import {
  assertValidAccountId,
  findAccount,
  readAccountsIndex,
  upsertAccount,
  type AccountRecord,
  type AccountStorageScheme
} from "./accounts.js";

const SERVICE = "copillm";
// The legacy keychain account string. Single-account installs (and the default
// account on multi-account installs) keep using this exact key so upgrading to
// a multi-account-aware build never invalidates an existing login. Additional
// accounts are namespaced as `${LEGACY_ACCOUNT}:<id>`.
const LEGACY_ACCOUNT = "github-oauth-token";
// Map key for the default account's in-memory session credential. Chosen so it
// can't collide with a real account id (those can't contain ':').
const DEFAULT_SESSION_KEY = "::default::";

/**
 * Where a single account's token lives across all three backends. The default
 * account resolves to the legacy locations; named accounts get id-namespaced
 * locations so their tokens never overwrite the pre-existing default.
 */
interface AccountStorage {
  keychainAccount: string;
  filePath: string;
  fileReadPath: string;
  sessionKey: string;
}

function legacyStorage(): AccountStorage {
  return {
    keychainAccount: LEGACY_ACCOUNT,
    filePath: credentialsPath(),
    fileReadPath: credentialsReadPath(),
    sessionKey: DEFAULT_SESSION_KEY
  };
}

function namespacedStorage(accountId: string): AccountStorage {
  assertValidAccountId(accountId);
  return {
    keychainAccount: `${LEGACY_ACCOUNT}:${accountId}`,
    filePath: accountCredentialsPath(accountId),
    fileReadPath: accountCredentialsReadPath(accountId),
    sessionKey: accountId
  };
}

function storageForScheme(accountId: string, scheme: AccountStorageScheme): AccountStorage {
  return scheme === "legacy" ? legacyStorage() : namespacedStorage(accountId);
}

/**
 * Resolve the storage for a specific account id. A registered account uses the
 * scheme recorded in its index entry (so the default/legacy account keeps the
 * legacy keys even when addressed by id). An unregistered id is assumed to be a
 * not-yet-persisted named account and gets namespaced storage.
 */
function storageForAccountId(accountId: string): AccountStorage {
  const record = findAccount(accountId);
  return record ? storageForScheme(record.id, record.storage) : namespacedStorage(accountId);
}

/**
 * Storage for the *default* account. With no accounts index this is the legacy
 * single-account storage — the path every existing install takes — so the
 * exported `loadStoredCredential` / `saveStoredCredential` / etc. behave
 * identically to the pre-multi-account build.
 */
function defaultAccountStorage(): AccountStorage {
  const index = readAccountsIndex();
  if (!index) {
    return legacyStorage();
  }
  const record = index.accounts.find((account) => account.id === index.defaultAccount);
  return record ? storageForScheme(record.id, record.storage) : legacyStorage();
}

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

// Module-level in-memory credentials, keyed by account session key. Only
// populated when SaveMode === "session". Never persisted; cleared on
// clearStoredCredential() and on process exit.
const sessionCredentials = new Map<string, { token: string; accountType: AccountType }>();

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

function parseCredentialFile(readPath: string): { token: string; accountType: AccountType } {
  const raw = readFileSync(readPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Credential file exists but contains invalid JSON at ${readPath}: ${error.message}`);
    }
    throw new Error(`Credential file exists but contains invalid JSON at ${readPath}.`);
  }

  try {
    const parsed = FileCredentialSchema.parse(parsedJson);
    return { token: parsed.github_token, accountType: parsed.account_type };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Credential file exists but is invalid at ${readPath}: ${error.message}`);
    }
    throw new Error(`Credential file exists but is invalid at ${readPath}.`);
  }
}

function writeCredentialFile(writePath: string, token: string, accountType: AccountType): void {
  ensureAppHome();
  const payload: StoredCredentialFile = {
    version: 1,
    github_token: token,
    account_type: accountType,
    saved_at: new Date().toISOString()
  };
  writeFileSecureAtomic(writePath, JSON.stringify(payload, null, 2), 0o600);
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
async function inspectStorage(storage: AccountStorage): Promise<{ stored: boolean; backend: null | CredentialBackend }> {
  if (sessionCredentials.has(storage.sessionKey)) {
    return { stored: true, backend: "session" };
  }
  if (fs.existsSync(storage.fileReadPath)) {
    return { stored: true, backend: "file" };
  }
  const { keyring } = await resolveKeyring();
  if (!keyring) {
    return { stored: false, backend: null };
  }
  try {
    const token = await keyring.getPassword(SERVICE, storage.keychainAccount);
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

async function loadStorage(storage: AccountStorage): Promise<null | StoredCredential> {
  const session = sessionCredentials.get(storage.sessionKey);
  if (session) {
    return { token: session.token, accountType: session.accountType, source: "session" };
  }
  if (fs.existsSync(storage.fileReadPath)) {
    const parsed = parseCredentialFile(storage.fileReadPath);
    return { token: parsed.token, accountType: parsed.accountType, source: "file" };
  }

  const { keyring } = await resolveKeyring();
  if (!keyring) {
    return null;
  }

  let token: null | string;
  try {
    token = await keyring.getPassword(SERVICE, storage.keychainAccount);
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

async function loadStorageForStatus(storage: AccountStorage): Promise<
  | { stored: false; backend: null; token: null }
  | { stored: true; backend: CredentialBackend; token: string }
> {
  const session = sessionCredentials.get(storage.sessionKey);
  if (session) {
    return { stored: true, backend: "session", token: session.token };
  }
  if (fs.existsSync(storage.fileReadPath)) {
    const parsed = parseCredentialFile(storage.fileReadPath);
    return { stored: true, backend: "file", token: parsed.token };
  }
  const { keyring } = await resolveKeyring();
  if (!keyring) {
    return { stored: false, backend: null, token: null };
  }
  try {
    const token = await keyring.getPassword(SERVICE, storage.keychainAccount);
    if (token) {
      return { stored: true, backend: "keyring", token };
    }
    return { stored: false, backend: null, token: null };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to read token from OS keychain: ${error.message}`);
    }
    throw new Error("Failed to read token from OS keychain.");
  }
}

async function saveStorage(
  storage: AccountStorage,
  token: string,
  accountType: AccountType,
  mode: SaveMode
): Promise<CredentialBackend> {
  if (mode === "session") {
    sessionCredentials.set(storage.sessionKey, { token, accountType });
    return "session";
  }

  if (fs.existsSync(storage.fileReadPath)) {
    parseCredentialFile(storage.fileReadPath);
    writeCredentialFile(storage.filePath, token, accountType);
    return "file";
  }

  const { keyring, reason } = await resolveKeyring();
  if (keyring) {
    try {
      await keyring.setPassword(SERVICE, storage.keychainAccount, token);
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
  writeCredentialFile(storage.filePath, token, accountType);
  return "file";
}

async function clearStorage(storage: AccountStorage): Promise<{ backend: CredentialBackend; removed: boolean }> {
  // Always clear in-memory session token first; it shadows other backends.
  const hadSession = sessionCredentials.delete(storage.sessionKey);

  const readablePath = storage.fileReadPath;
  const canonicalPath = storage.filePath;
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
      const removed = await keyring.deletePassword(SERVICE, storage.keychainAccount);
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

// ---------------------------------------------------------------------------
// Default-account surface. With no accounts index these operate on the legacy
// single-account storage, so behaviour is identical to the pre-multi-account
// build. With an index they target whichever account is currently the default.
// ---------------------------------------------------------------------------

export async function inspectStoredCredential(): Promise<{ stored: boolean; backend: null | CredentialBackend }> {
  return inspectStorage(defaultAccountStorage());
}

export async function loadStoredCredential(): Promise<null | StoredCredential> {
  return loadStorage(defaultAccountStorage());
}

/**
 * Coalesced inspect + load for status surfaces. Returns the same fields
 * `inspectStoredCredential` exposes (`stored` + `backend`) AND the
 * `token` — but performs only ONE backend probe.
 *
 * Previously, `auth status` with user-lookup enabled did:
 *   1. `inspectStoredCredential` → one `keyring.getPassword` (backend probe)
 *   2. `loadStoredCredential` (inside `inspectGithubIdentity`) → another
 *      `keyring.getPassword` (full token read)
 *
 * On macOS, each call is its own keychain audit-log entry and (on a
 * misconfigured system) its own permission prompt. This helper folds both
 * into a single backend probe + single read.
 *
 * SECURITY: callers MUST treat the `token` field as sensitive — do not log,
 * print, or persist it. The status JSON output and `formatHumanAuthStatusLine`
 * only consume `backend` (and the upstream identity summary returned by
 * `inspectGithubIdentity`), never `token` directly. Enforced at the call
 * site (`tests/integration/authStatusCli.test.ts` runs a substring-leak
 * guard on the printed output).
 */
export async function loadStoredCredentialForStatus(): Promise<
  | { stored: false; backend: null; token: null }
  | { stored: true; backend: CredentialBackend; token: string }
> {
  return loadStorageForStatus(defaultAccountStorage());
}

export async function saveStoredCredential(
  token: string,
  accountType: AccountType,
  options: { mode?: SaveMode } = {}
): Promise<CredentialBackend> {
  return saveStorage(defaultAccountStorage(), token, accountType, options.mode ?? "auto");
}

export async function clearStoredCredential(): Promise<{ backend: CredentialBackend; removed: boolean }> {
  return clearStorage(defaultAccountStorage());
}

// ---------------------------------------------------------------------------
// Account-scoped surface. These address a specific account by id regardless of
// which one is the default. A registered account uses the storage scheme from
// its index entry (so the legacy/default account keeps the legacy keys); an
// unregistered id is treated as a not-yet-persisted namespaced account.
// ---------------------------------------------------------------------------

export async function inspectStoredCredentialForAccount(
  accountId: string
): Promise<{ stored: boolean; backend: null | CredentialBackend }> {
  return inspectStorage(storageForAccountId(accountId));
}

export async function loadStoredCredentialForAccount(accountId: string): Promise<null | StoredCredential> {
  const loaded = await loadStorage(storageForAccountId(accountId));
  if (!loaded) {
    return loaded;
  }
  // The keychain backend can't store the account type, so `loadStorage`
  // defaults it to "individual". The index records the real type per account —
  // prefer it so model-discovery base-URL selection stays correct.
  if (loaded.source === "keyring") {
    const record = findAccount(accountId);
    if (record) {
      return { ...loaded, accountType: record.accountType };
    }
  }
  return loaded;
}

export async function saveStoredCredentialForAccount(
  accountId: string,
  token: string,
  accountType: AccountType,
  options: { mode?: SaveMode } = {}
): Promise<CredentialBackend> {
  return saveStorage(storageForAccountId(accountId), token, accountType, options.mode ?? "auto");
}

export async function clearStoredCredentialForAccount(
  accountId: string
): Promise<{ backend: CredentialBackend; removed: boolean }> {
  return clearStorage(storageForAccountId(accountId));
}

/**
 * Materialize the accounts index from a pre-existing single-account install.
 * Registers the current legacy credential as the default account with
 * `storage: "legacy"` so its token is **not moved** — the keychain entry and
 * `credentials.json` stay exactly where they are. Idempotent: if the index
 * already exists it is returned unchanged. Use this before adding a second
 * account so the original login is represented without any invalidation risk.
 */
export function registerExistingCredentialAsDefault(accountId: string, accountType: AccountType): AccountRecord {
  assertValidAccountId(accountId);
  const existing = readAccountsIndex();
  if (existing) {
    const current = existing.accounts.find((account) => account.id === existing.defaultAccount);
    if (current) {
      return current;
    }
  }
  const record: AccountRecord = {
    id: accountId,
    accountType,
    storage: "legacy",
    addedAt: new Date().toISOString()
  };
  upsertAccount(record);
  return record;
}

// Test seam: forcibly clear all in-memory session credentials. Not exported via
// the package surface for end users — only used by unit tests.
export function __resetSessionCredentialForTests(): void {
  sessionCredentials.clear();
}
