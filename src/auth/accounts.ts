import fs from "node:fs";
import { z } from "zod";
import type { AccountType } from "../types/index.js";
import { ensureAppHome } from "../config/config.js";
import { accountsIndexPath, accountsIndexReadPath } from "../config/home.js";
import { writeFileSecureAtomic } from "../config/fsSecurity.js";
import {
  ACCOUNT_ID_PATTERN,
  MAX_ACCOUNT_ID_LENGTH,
  assertValidAccountId,
  InvalidAccountIdError
} from "../config/accountId.js";

// Re-exported for callers that historically imported account-id validation
// from this module (e.g. `credentials.ts`). The canonical definition now lives
// in `config/accountId.ts` so the `models` layer can share it.
export { assertValidAccountId, InvalidAccountIdError };

/**
 * The `accounts.json` index records *which* GitHub accounts copillm knows
 * about and which one is the default. It holds metadata only — **never a
 * token**. Tokens live in the OS keychain, the per-account plaintext fallback
 * file, or the in-memory session backend, exactly as for the single-account
 * case (see `credentials.ts`).
 *
 * Backward compatibility: a single-account install has no `accounts.json` at
 * all. The pre-existing credential (legacy keychain entry / `credentials.json`)
 * keeps working as the implicit default account. The index is only
 * materialized once the user adds a second account or otherwise opts into the
 * multi-account surface; at that point the pre-existing credential is recorded
 * with `storage: "legacy"` so its token is never moved.
 */

/**
 * Where an account's token is physically stored:
 *  - `"legacy"`    → the original `github-oauth-token` keychain entry and
 *                    `credentials.json` file. Reserved for the pre-existing /
 *                    primary account so upgrades never invalidate it.
 *  - `"namespaced"`→ `github-oauth-token:<id>` keychain entry and
 *                    `credentials.<id>.json` file. Used for every account added
 *                    after the first.
 */
export type AccountStorageScheme = "legacy" | "namespaced";

export interface AccountRecord {
  id: string;
  accountType: AccountType;
  storage: AccountStorageScheme;
  addedAt: string;
}

export interface AccountsIndex {
  version: 1;
  defaultAccount: string;
  accounts: AccountRecord[];
}

// GitHub logins are `[A-Za-z0-9-]` and copillm allows `.` / `_` for synthetic
// ids. The id is embedded in a filename (`credentials.<id>.json`) and a
// keychain account string; the canonical validation lives in
// `config/accountId.ts` (shared with the models layer).

const AccountRecordSchema = z.object({
  id: z.string().min(1).max(MAX_ACCOUNT_ID_LENGTH).regex(ACCOUNT_ID_PATTERN),
  accountType: z.enum(["individual", "business", "enterprise"]),
  storage: z.enum(["legacy", "namespaced"]),
  addedAt: z.string().min(1)
});

const AccountsIndexSchema = z
  .object({
    version: z.literal(1),
    defaultAccount: z.string().min(1),
    accounts: z.array(AccountRecordSchema)
  })
  .superRefine((value, ctx) => {
    const ids = value.accounts.map((account) => account.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "accounts.json contains duplicate account ids." });
    }
    if (!ids.includes(value.defaultAccount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `accounts.json defaultAccount "${value.defaultAccount}" is not present in accounts.`
      });
    }
    if (value.accounts.filter((account) => account.storage === "legacy").length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "accounts.json may declare at most one legacy-storage account." });
    }
  });

/**
 * Read and validate the accounts index. Returns `null` when no index exists
 * (the single-account / legacy case). Throws if the file exists but is
 * corrupt, so a damaged index surfaces loudly rather than silently dropping
 * accounts.
 */
export function readAccountsIndex(): null | AccountsIndex {
  const path = accountsIndexReadPath();
  if (!fs.existsSync(path)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Accounts index exists but contains invalid JSON at ${path}: ${detail}`);
  }
  const parsed = AccountsIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Accounts index exists but is invalid at ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

export function writeAccountsIndex(index: AccountsIndex): void {
  const validated = AccountsIndexSchema.parse(index);
  ensureAppHome();
  writeFileSecureAtomic(accountsIndexPath(), JSON.stringify(validated, null, 2), 0o600);
}

export function listAccounts(): AccountRecord[] {
  return readAccountsIndex()?.accounts ?? [];
}

/**
 * The default account id, or `null` when no index exists. A `null` return is
 * the signal to callers to use the legacy single-account storage path.
 */
export function getDefaultAccountId(): null | string {
  return readAccountsIndex()?.defaultAccount ?? null;
}

export function findAccount(accountId: string): null | AccountRecord {
  return readAccountsIndex()?.accounts.find((account) => account.id === accountId) ?? null;
}

/**
 * Insert or update an account record, then persist the index. When the index
 * does not yet exist it is created with this account as the default. Returns
 * the resulting index.
 */
export function upsertAccount(record: AccountRecord): AccountsIndex {
  assertValidAccountId(record.id);
  AccountRecordSchema.parse(record);
  const existing = readAccountsIndex();
  if (!existing) {
    const index: AccountsIndex = { version: 1, defaultAccount: record.id, accounts: [record] };
    writeAccountsIndex(index);
    return index;
  }
  const accounts = existing.accounts.filter((account) => account.id !== record.id);
  accounts.push(record);
  const index: AccountsIndex = { ...existing, accounts };
  writeAccountsIndex(index);
  return index;
}

export class UnknownAccountError extends Error {
  public constructor(public readonly accountId: string) {
    super(`Unknown account "${accountId}".`);
    this.name = "UnknownAccountError";
  }
}

/**
 * Point the default at an existing account. Throws `UnknownAccountError` if the
 * id isn't registered, so a typo can't silently orphan the default.
 */
export function setDefaultAccountId(accountId: string): AccountsIndex {
  const existing = readAccountsIndex();
  if (!existing || !existing.accounts.some((account) => account.id === accountId)) {
    throw new UnknownAccountError(accountId);
  }
  const index: AccountsIndex = { ...existing, defaultAccount: accountId };
  writeAccountsIndex(index);
  return index;
}

/**
 * Remove an account from the index. Returns the updated index, or `null` if no
 * index existed. When the removed account was the default, the default falls
 * back to the first remaining account (or the index is deleted entirely if no
 * accounts remain). Token removal is the caller's responsibility.
 */
export function removeAccount(accountId: string): null | AccountsIndex {
  const existing = readAccountsIndex();
  if (!existing) {
    return null;
  }
  const accounts = existing.accounts.filter((account) => account.id !== accountId);
  if (accounts.length === existing.accounts.length) {
    return existing;
  }
  if (accounts.length === 0) {
    deleteAccountsIndex();
    return null;
  }
  const defaultAccount = accounts.some((account) => account.id === existing.defaultAccount)
    ? existing.defaultAccount
    : accounts[0].id;
  const index: AccountsIndex = { ...existing, defaultAccount, accounts };
  writeAccountsIndex(index);
  return index;
}

function deleteAccountsIndex(): void {
  const canonical = accountsIndexPath();
  if (fs.existsSync(canonical)) {
    fs.unlinkSync(canonical);
  }
  const readable = accountsIndexReadPath();
  if (readable !== canonical && fs.existsSync(readable)) {
    fs.unlinkSync(readable);
  }
}
