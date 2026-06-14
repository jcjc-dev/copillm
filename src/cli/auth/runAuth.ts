import { setTimeout as sleep } from "node:timers/promises";
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
  switchDefaultAccount,
  type AddAccountResult
} from "../../auth/accountManager.js";
import { loginViaDeviceFlow } from "../../auth/deviceFlow.js";
import { inspectGithubIdentity } from "../../auth/githubIdentity.js";
import { loadConfig } from "../../config/config.js";
import { inspectLock, releaseLock } from "../../server/lock.js";
import { stopByPid } from "../daemon/lifecycle.js";
import { describeBackend } from "../shared/backends.js";
import { writeCommandOutput } from "../shared/output.js";

export interface AuthLoginOpts {
  json?: boolean;
  as?: string;
  accountType?: AccountType;
}

/**
 * Derive a friendly, path-safe account id from the GitHub login behind a token.
 * Returns null when the lookup fails or the login isn't a valid id.
 *
 * Multi-account routing now depends on this, so it retries a few times with a
 * generous timeout: GitHub's `/user` can briefly throttle or lag right after a
 * device-flow token exchange, and a single failed probe must not cause the
 * caller to mis-identify (and overwrite) the wrong account.
 */
async function deriveAccountId(token: string): Promise<string | null> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let identity: Awaited<ReturnType<typeof inspectGithubIdentity>> = null;
    try {
      identity = await inspectGithubIdentity({ token, timeoutMs: 8_000 });
    } catch {
      identity = null;
    }
    const login = identity?.login;
    if (login) {
      try {
        assertValidAccountId(login);
        return login;
      } catch {
        return null;
      }
    }
    if (attempt < attempts) {
      await sleep(400 * attempt);
    }
  }
  return null;
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

  // ---- Explicit name (`--as`) -------------------------------------------
  if (namedRequested) {
    const accountId = opts.as!.trim();
    // First time we materialize the index via an explicit name: preserve any
    // pre-existing single account as the default so its token isn't clobbered.
    if (!index) {
      const existing = await loadStoredCredential();
      if (existing) {
        const existingId = (await deriveAccountId(existing.token)) ?? "default";
        if (existingId !== accountId) {
          registerExistingCredentialAsDefault(existingId, existing.accountType);
        }
      }
    }
    const result = await addAccount({ id: accountId, accountType, token, mode: saveMode, makeDefault: true });
    emitLoginResult(opts, result);
    return;
  }

  // ---- No name: auto-manage by the token's GitHub login -----------------
  // Identify the account from its GitHub login so a second `auth login` for a
  // DIFFERENT account is kept alongside the first instead of overwriting it.
  // The cardinal rule: never replace an existing credential unless we have
  // positively confirmed it's the SAME GitHub account.
  const newLogin = await deriveAccountId(token);
  const existing = await loadStoredCredential();

  if (!existing) {
    // Nothing stored yet.
    if (index) {
      // An index exists but its default account has no credential — restore it.
      const targetId = newLogin ?? index.defaultAccount;
      const result = await addAccount({ id: targetId, accountType, token, mode: saveMode, makeDefault: true });
      emitLoginResult(opts, result);
      return;
    }
    // Fresh single-account install: store without creating an index.
    const backend = await saveStoredCredential(token, accountType, { mode: saveMode });
    writeCommandOutput(opts, `Login succeeded. Credentials stored via ${describeBackend(backend)}.`, {
      status: "ok",
      action: "login",
      credential_backend: backend
    });
    return;
  }

  // A credential already exists. We must know which GitHub account just signed
  // in before we touch anything, or we risk clobbering a different account.
  if (!newLogin) {
    writeCommandOutput(
      opts,
      "Login failed: couldn't verify which GitHub account you signed in as (the GitHub user lookup didn't succeed). " +
        "Your existing credentials were left untouched. Re-run `copillm auth login`, or name this account explicitly with `copillm auth login --as <name>`.",
      { status: "error", action: "login", error: "github_identity_unresolved" }
    );
    process.exitCode = 1;
    return;
  }

  if (index) {
    // Add the new login as its own account, or refresh it in place if known.
    // The just-signed-in account becomes the default — that's the account you
    // clearly intend to use right now.
    const result = await addAccount({ id: newLogin, accountType, token, mode: saveMode, makeDefault: true });
    emitLoginResult(opts, result);
    return;
  }

  // No index yet. Compare against the existing single account.
  const existingLogin = await deriveAccountId(existing.token);
  if (existingLogin === newLogin) {
    // Confirmed the SAME account → refresh in place, no index created.
    const backend = await saveStoredCredential(token, accountType, { mode: saveMode });
    writeCommandOutput(opts, `Login succeeded. Credentials stored via ${describeBackend(backend)}.`, {
      status: "ok",
      action: "login",
      credential_backend: backend
    });
    return;
  }

  // A different (or unverifiable) prior account → transition to multi-account,
  // preserving the prior login and making the just-signed-in account the
  // default (the one you clearly intend to use now).
  registerExistingCredentialAsDefault(existingLogin ?? "default", existing.accountType);
  const result = await addAccount({ id: newLogin, accountType, token, mode: saveMode, makeDefault: true });
  emitLoginResult(opts, result);
}

function emitLoginResult(opts: AuthLoginOpts, result: AddAccountResult): void {
  const defaultNote = result.isDefault ? " — now the default account" : "";
  writeCommandOutput(opts, `Logged in as "${result.id}"${defaultNote}.`, {
    status: "ok",
    action: "login",
    account: result.id,
    account_type: result.accountType,
    is_default: result.isDefault,
    credential_backend: result.backend
  });
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

  // Human view: lead with the default account (the one in use right now),
  // then a compact, aligned list. Avoid repeating the same login three times —
  // the account id is the handle; show extra detail only when it adds something.
  const ordered = [...enriched].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const idWidth = Math.min(32, Math.max(...ordered.map((a) => a.id.length)));
  const defaultId = listing.defaultAccount ?? ordered.find((a) => a.isDefault)?.id ?? null;

  const header = defaultId
    ? `copillm — ${enriched.length} account${enriched.length === 1 ? "" : "s"} · default: ${defaultId}`
    : `copillm — ${enriched.length} account${enriched.length === 1 ? "" : "s"}`;
  process.stdout.write(`${header}\n\n`);

  for (const account of ordered) {
    const marker = account.isDefault ? "*" : " ";
    const notes: string[] = [];
    if (account.isDefault) notes.push("default");
    if (!account.stored) notes.push("no credential");
    // Only surface the GitHub login when it differs from the account id (e.g. a
    // custom --as name); otherwise it's redundant.
    if (account.login && account.login !== account.id) notes.push(`@${account.login}`);
    const noteStr = notes.length > 0 ? `  (${notes.join(", ")})` : "";
    process.stdout.write(`  ${marker} ${account.id.padEnd(idWidth)}${noteStr}\n`);
  }

  process.stdout.write(`\nSwitch default: copillm auth switch <account>   ·   per launch: --account <account>\n`);
  return { anyStored };
}
