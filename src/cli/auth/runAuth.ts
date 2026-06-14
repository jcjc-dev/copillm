import type { AccountType } from "../../types/index.js";
import {
  clearStoredCredential,
  loadStoredCredential,
  loadStoredCredentialForAccount,
  registerExistingCredentialAsDefault,
  saveStoredCredential
} from "../../auth/credentials.js";
import {
  readAccountsIndex,
  assertValidAccountId,
  InvalidAccountIdError,
  UnknownAccountError
} from "../../auth/accounts.js";
import {
  addAccount,
  listAccountsDetailed,
  removeAccountAndCredential,
  removeAllAccounts,
  switchDefaultAccount
} from "../../auth/accountManager.js";
import { loginViaDeviceFlow } from "../../auth/deviceFlow.js";
import { inspectGithubIdentity } from "../../auth/githubIdentity.js";
import { loadConfig } from "../../config/config.js";
import { inspectLock, releaseLock } from "../../server/lock.js";
import { stopByPid } from "../daemon/lifecycle.js";
import { describeBackend, formatHumanAuthStatusLine } from "../shared/backends.js";
import { writeCommandOutput } from "../shared/output.js";

export interface AuthLoginOpts {
  json?: boolean;
  as?: string;
  accountType?: AccountType;
}

/**
 * Derive a friendly, path-safe account id from the GitHub login behind a token.
 * Returns null when the lookup fails or the login isn't a valid id.
 */
async function deriveAccountId(token: string): Promise<string | null> {
  let identity: Awaited<ReturnType<typeof inspectGithubIdentity>>;
  try {
    identity = await inspectGithubIdentity({ token });
  } catch {
    return null;
  }
  const login = identity?.login;
  if (!login) {
    return null;
  }
  try {
    assertValidAccountId(login);
    return login;
  } catch {
    return null;
  }
}

export async function runAuthLogin(opts: AuthLoginOpts, options: { forceSession: boolean }): Promise<void> {
  if (options.forceSession) {
    process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  }
  const config = loadConfig();
  const accountType: AccountType = opts.accountType ?? config.accountType;
  const namedRequested = typeof opts.as === "string" && opts.as.trim().length > 0;

  if (namedRequested) {
    try {
      assertValidAccountId(opts.as!.trim());
    } catch (error) {
      const message = error instanceof InvalidAccountIdError ? error.message : "invalid account id";
      writeCommandOutput(opts, `Login failed: ${message}`, { status: "error", action: "login", error: message });
      process.exitCode = 1;
      return;
    }
  }

  const token = await loginViaDeviceFlow();
  const saveMode = options.forceSession ? "session" : "auto";
  const index = readAccountsIndex();

  // Pure single-account login: no index and no explicit name. Preserve the
  // historical behaviour exactly — legacy storage, no accounts index created.
  if (!index && !namedRequested) {
    const backend = await saveStoredCredential(token, accountType, { mode: saveMode });
    writeCommandOutput(opts, `Login succeeded. Credentials stored via ${describeBackend(backend)}.`, {
      status: "ok",
      action: "login",
      credential_backend: backend
    });
    return;
  }

  const accountId = namedRequested ? opts.as!.trim() : index!.defaultAccount;

  // First time we materialize the index via an explicit name: preserve any
  // pre-existing single account as the default so its token isn't clobbered.
  if (!index && namedRequested) {
    const existing = await loadStoredCredential();
    if (existing) {
      const existingId = (await deriveAccountId(existing.token)) ?? "default";
      if (existingId !== accountId) {
        registerExistingCredentialAsDefault(existingId, existing.accountType);
      }
    }
  }

  const result = await addAccount({ id: accountId, accountType, token, mode: saveMode });
  const defaultSuffix = result.isDefault ? " (default)" : "";
  writeCommandOutput(
    opts,
    `Login succeeded for account "${result.id}"${defaultSuffix}. Credentials stored via ${describeBackend(result.backend)}.`,
    {
      status: "ok",
      action: "login",
      account: result.id,
      account_type: result.accountType,
      is_default: result.isDefault,
      credential_backend: result.backend
    }
  );
}

async function stopRunningDaemon(): Promise<void> {
  const lockState = inspectLock();
  if (lockState.state === "running") {
    await stopByPid(lockState.lock.pid);
  } else if (lockState.state === "stale") {
    releaseLock();
  }
}

export interface AuthLogoutOpts {
  json?: boolean;
  account?: string;
  all?: boolean;
}

export async function runAuthLogout(opts: AuthLogoutOpts): Promise<void> {
  // Stopping the daemon is always part of logout — its in-memory bearers are
  // derived from the credentials we're clearing.
  if (opts.all) {
    const result = await removeAllAccounts();
    await stopRunningDaemon();
    writeCommandOutput(opts, `Logged out of all accounts (${result.clearedCount} credential(s) cleared).`, {
      status: "ok",
      action: "logout",
      scope: "all",
      cleared_count: result.clearedCount,
      removed_accounts: result.removedAccountIds
    });
    return;
  }

  const index = readAccountsIndex();

  // Single-account install (no index) and no explicit target: preserve the
  // historical single-account logout behaviour.
  if (!index && !opts.account) {
    const result = await clearStoredCredential();
    await stopRunningDaemon();
    const credentialStatus = result.removed ? "removed" : "not present";
    writeCommandOutput(opts, `Logged out. Credentials ${credentialStatus} from ${describeBackend(result.backend)}.`, {
      status: "ok",
      action: "logout",
      credential_backend: result.backend,
      credential_removed: result.removed
    });
    return;
  }

  if (opts.account) {
    try {
      assertValidAccountId(opts.account);
    } catch (error) {
      const message = error instanceof InvalidAccountIdError ? error.message : "invalid account id";
      writeCommandOutput(opts, `Logout failed: ${message}`, { status: "error", action: "logout", error: message });
      process.exitCode = 1;
      return;
    }
  }

  const targetId = opts.account ?? index!.defaultAccount;
  const result = await removeAccountAndCredential(targetId);
  await stopRunningDaemon();
  const credentialStatus = result.removed ? "removed" : "not present";
  const tail = result.indexDeleted
    ? " No accounts remain."
    : result.newDefault
      ? ` Default is now "${result.newDefault}".`
      : "";
  writeCommandOutput(
    opts,
    `Logged out of account "${result.id}". Credentials ${credentialStatus} from ${describeBackend(result.backend)}.${tail}`,
    {
      status: "ok",
      action: "logout",
      account: result.id,
      credential_backend: result.backend,
      credential_removed: result.removed,
      new_default: result.newDefault,
      index_deleted: result.indexDeleted
    }
  );
}

export async function runAuthSwitch(opts: { json?: boolean }, accountId: string): Promise<void> {
  try {
    assertValidAccountId(accountId);
    const index = switchDefaultAccount(accountId);
    writeCommandOutput(opts, `Default account is now "${index.defaultAccount}".`, {
      status: "ok",
      action: "switch",
      default_account: index.defaultAccount
    });
  } catch (error) {
    const message =
      error instanceof UnknownAccountError
        ? `Unknown account "${accountId}". Run \`copillm auth status\` to list accounts.`
        : error instanceof InvalidAccountIdError
          ? error.message
          : error instanceof Error
            ? error.message
            : "switch failed";
    writeCommandOutput(opts, `Switch failed: ${message}`, { status: "error", action: "switch", error: message });
    process.exitCode = 1;
  }
}

/**
 * Multi-account `auth status` listing (used when an accounts index exists).
 * Returns whether any account has a stored credential so the caller can pick
 * the process exit code. Never prints a token.
 */
export async function runAuthStatusList(opts: { json?: boolean; user?: boolean }): Promise<{ anyStored: boolean }> {
  const wantUser = opts.user !== false;
  const listing = await listAccountsDetailed();
  const anyStored = listing.accounts.some((account) => account.stored);

  const enriched = await Promise.all(
    listing.accounts.map(async (account) => {
      let login: string | null = null;
      let name: string | null = null;
      if (wantUser && account.stored) {
        try {
          const credential = await loadStoredCredentialForAccount(account.id);
          if (credential) {
            const identity = await inspectGithubIdentity({ token: credential.token });
            login = identity?.login ?? null;
            name = identity?.name ?? null;
          }
        } catch {
          login = null;
          name = null;
        }
      }
      return { ...account, login, name };
    })
  );

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: anyStored ? "logged_in" : "logged_out",
          default: listing.defaultAccount,
          accounts: enriched.map((account) => ({
            id: account.id,
            account_type: account.accountType,
            storage: account.storage,
            default: account.isDefault,
            stored: account.stored,
            backend: account.backend,
            user: account.login ? { login: account.login, name: account.name } : null
          }))
        },
        null,
        2
      ) + "\n"
    );
    return { anyStored };
  }

  process.stdout.write(`copillm — ${enriched.length} account(s)\n`);
  for (const account of enriched) {
    const marker = account.isDefault ? "*" : " ";
    const who = account.login ? ` @${account.login}` : "";
    const state = account.stored
      ? formatHumanAuthStatusLine(account.backend, account.login ? { login: account.login, name: account.name } : null)
      : "no credential";
    process.stdout.write(`${marker} ${account.id}  [${account.accountType}]${who}  — ${state}\n`);
  }
  return { anyStored };
}
