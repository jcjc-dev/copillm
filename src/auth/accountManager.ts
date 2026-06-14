import type { AccountType } from "../types/index.js";
import {
  findAccount,
  readAccountsIndex,
  removeAccount,
  setDefaultAccountId,
  upsertAccount,
  assertValidAccountId,
  type AccountStorageScheme,
  type AccountsIndex
} from "./accounts.js";
import {
  clearStoredCredential,
  clearStoredCredentialForAccount,
  inspectStoredCredentialForAccount,
  saveStoredCredentialForAccount,
  type CredentialBackend,
  type SaveMode
} from "./credentials.js";

/**
 * Coordination layer between the accounts index (which account exists / is
 * default) and the credential store (where each account's token lives). The
 * CLI drives these; they contain no device-flow or network logic so they can
 * be unit-tested directly.
 */

export interface AddAccountResult {
  id: string;
  accountType: AccountType;
  storage: AccountStorageScheme;
  backend: CredentialBackend;
  isDefault: boolean;
}

/**
 * Add or update an explicitly-identified account, materializing/extending the
 * accounts index, and store its credential.
 *
 * Storage scheme follows the credential-store invariant: the **first** account
 * (no index yet) takes legacy storage so it keeps the original keychain entry /
 * `credentials.json`; every account added afterwards is namespaced. An existing
 * account keeps whatever storage it already has.
 */
export async function addAccount(input: {
  id: string;
  accountType: AccountType;
  token: string;
  makeDefault?: boolean;
  mode?: SaveMode;
}): Promise<AddAccountResult> {
  assertValidAccountId(input.id);
  const index = readAccountsIndex();
  const existing = findAccount(input.id);
  const storage: AccountStorageScheme = existing ? existing.storage : index ? "namespaced" : "legacy";

  upsertAccount({
    id: input.id,
    accountType: input.accountType,
    storage,
    addedAt: existing?.addedAt ?? new Date().toISOString()
  });

  // saveStoredCredentialForAccount resolves storage from the index record we
  // just wrote, so it lands in the right (legacy vs namespaced) location.
  const backend = await saveStoredCredentialForAccount(input.id, input.token, input.accountType, {
    mode: input.mode ?? "auto"
  });

  let isDefault = readAccountsIndex()?.defaultAccount === input.id;
  if (input.makeDefault && !isDefault) {
    setDefaultAccountId(input.id);
    isDefault = true;
  }
  return { id: input.id, accountType: input.accountType, storage, backend, isDefault };
}

export interface AccountSummary {
  id: string;
  accountType: AccountType;
  storage: AccountStorageScheme;
  isDefault: boolean;
  stored: boolean;
  backend: null | CredentialBackend;
}

export interface AccountsListing {
  hasIndex: boolean;
  defaultAccount: string | null;
  accounts: AccountSummary[];
}

/**
 * Detailed, token-free view of every registered account for `auth status`.
 * Returns `hasIndex: false` for single-account installs so the caller can use
 * the legacy single-account output unchanged.
 */
export async function listAccountsDetailed(): Promise<AccountsListing> {
  const index = readAccountsIndex();
  if (!index) {
    return { hasIndex: false, defaultAccount: null, accounts: [] };
  }
  const accounts: AccountSummary[] = [];
  for (const record of index.accounts) {
    const info = await inspectStoredCredentialForAccount(record.id);
    accounts.push({
      id: record.id,
      accountType: record.accountType,
      storage: record.storage,
      isDefault: record.id === index.defaultAccount,
      stored: info.stored,
      backend: info.backend
    });
  }
  return { hasIndex: true, defaultAccount: index.defaultAccount, accounts };
}

export interface RemoveAccountResult {
  id: string;
  removed: boolean;
  backend: CredentialBackend;
  newDefault: string | null;
  indexDeleted: boolean;
}

/**
 * Remove one account: clear its credential first (while its index record still
 * exists, so the correct storage location is targeted), then drop it from the
 * index (which reassigns the default, or deletes the index when it was the
 * last account). Clearing is best-effort — an absent credential is reported as
 * `removed: false` rather than failing the removal.
 */
export async function removeAccountAndCredential(id: string): Promise<RemoveAccountResult> {
  assertValidAccountId(id);
  let removed = false;
  let backend: CredentialBackend = "file";
  try {
    const cleared = await clearStoredCredentialForAccount(id);
    removed = cleared.removed;
    backend = cleared.backend;
  } catch {
    // No backend available to clear (e.g. nothing was stored). The account is
    // still removed from the index below.
    removed = false;
  }
  const index = removeAccount(id);
  return {
    id,
    removed,
    backend,
    newDefault: index?.defaultAccount ?? null,
    indexDeleted: index === null
  };
}

export interface RemoveAllResult {
  clearedCount: number;
  removedAccountIds: string[];
  indexDeleted: boolean;
}

/**
 * Remove every account and delete the index. For a single-account install (no
 * index) this just clears the legacy credential.
 */
export async function removeAllAccounts(): Promise<RemoveAllResult> {
  const index = readAccountsIndex();
  if (!index) {
    const cleared = await clearStoredCredential();
    return { clearedCount: cleared.removed ? 1 : 0, removedAccountIds: [], indexDeleted: false };
  }
  const ids = index.accounts.map((account) => account.id);
  let clearedCount = 0;
  for (const id of ids) {
    try {
      const cleared = await clearStoredCredentialForAccount(id);
      if (cleared.removed) {
        clearedCount += 1;
      }
    } catch {
      // Best-effort: an account with nothing stored still gets removed.
    }
    removeAccount(id);
  }
  return { clearedCount, removedAccountIds: ids, indexDeleted: true };
}

/** Point the default at an existing account. Throws `UnknownAccountError`. */
export function switchDefaultAccount(id: string): AccountsIndex {
  return setDefaultAccountId(id);
}
