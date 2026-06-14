import type { Command } from "commander";
import type { AccountType } from "../../types/index.js";
import { inspectStoredCredential, loadStoredCredentialForStatus } from "../../auth/credentials.js";
import { readAccountsIndex } from "../../auth/accounts.js";
import { inspectGithubIdentity, type GithubIdentitySummary } from "../../auth/githubIdentity.js";
import { ensureAuthenticatedInteractive } from "../auth/ensure.js";
import { runAuthLogin, runAuthLogout, runAuthStatusList, runAuthSwitch } from "../auth/runAuth.js";
import { formatHumanAuthStatusLine } from "../shared/backends.js";
import { emitDeprecation } from "../shared/deprecation.js";

const ACCOUNT_TYPES: readonly AccountType[] = ["individual", "business", "enterprise"];

function parseAccountType(value: string): AccountType {
  if ((ACCOUNT_TYPES as readonly string[]).includes(value)) {
    return value as AccountType;
  }
  throw new Error(`Invalid --account-type "${value}". Expected one of: ${ACCOUNT_TYPES.join(", ")}.`);
}

// Re-export for callers (e.g. start command) that need the interactive prompt.
export { ensureAuthenticatedInteractive };

export function register(program: Command): void {
  program
    .command("login")
    .description("[deprecated] Use `copillm auth login`")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      emitDeprecation(opts, "login", "auth login");
      await runAuthLogin(opts, { forceSession: false });
    });

  program
    .command("logout")
    .description("[deprecated] Use `copillm auth logout`")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      emitDeprecation(opts, "logout", "auth logout");
      await runAuthLogout(opts);
    });

  const auth = program.command("auth").description("Authentication commands");

  auth
    .command("login")
    .description("Authenticate with GitHub")
    .option("--json", "JSON output")
    .option("--as <account>", "Name this account (enables multiple accounts)")
    .option("--account-type <type>", "Account plan type: individual | business | enterprise", parseAccountType)
    // Undocumented test seam: force the session-only backend regardless of
    // whether the OS keychain is available. Equivalent to setting
    // COPILLM_FORCE_SESSION_BACKEND=1 for the duration of this command.
    .option("--force-session", "(test-only) force the session-only backend", false)
    .action(async (opts: { json?: boolean; as?: string; accountType?: AccountType; forceSession?: boolean }) => {
      await runAuthLogin(opts, { forceSession: Boolean(opts.forceSession) });
    });

  auth
    .command("logout")
    .description("Clear credentials and stop running daemon")
    .option("--json", "JSON output")
    .option("--account <account>", "Log out a specific account (default: the default account)")
    .option("--all", "Log out of every account")
    .action(async (opts: { json?: boolean; account?: string; all?: boolean }) => {
      await runAuthLogout(opts);
    });

  auth
    .command("switch")
    .argument("<account>", "Account id to make the default")
    .description("Set the default account")
    .option("--json", "JSON output")
    .action(async (account: string, opts: { json?: boolean }) => {
      await runAuthSwitch(opts, account);
    });

  auth
    .command("status")
    .description("Report whether a credential is stored (token is never printed)")
    .option("--json", "JSON output")
    .option("--no-user", "Skip the GitHub /user lookup that fetches the login name")
    .action(async (opts: { json?: boolean; user?: boolean }) => {
      // commander's --no-user toggles opts.user to false; when the flag is
      // omitted opts.user is undefined and we treat that as "fetch by default".
      const wantUserLookup = opts.user !== false;

      // Multi-account installs (an accounts index exists) get the per-account
      // listing. Single-account installs keep the exact original output below.
      if (readAccountsIndex()) {
        const { anyStored } = await runAuthStatusList(opts);
        process.exit(anyStored ? 0 : 2);
      }

      // Two paths to minimize keychain probes:
      //   - With user lookup (default): `loadStoredCredentialForStatus()`
      //     does ONE keychain read that yields backend + token. Pass the
      //     token into `inspectGithubIdentity({ token })` so it doesn't
      //     re-read the keychain.
      //   - Without user lookup (--no-user): `inspectStoredCredential()`
      //     does ONE keychain probe and never sees the token. Preserves
      //     the no-token invariant for the surface where it matters most.
      //
      // Previously, the user-lookup path made TWO keychain reads — one in
      // `inspectStoredCredential` then another in `inspectGithubIdentity` →
      // `loadStoredCredential`. That doubled macOS keychain audit-log
      // entries and doubled permission-prompt exposure on misconfigured
      // systems.
      let info: { stored: boolean; backend: null | import("../../auth/credentials.js").CredentialBackend };
      let token: undefined | string;
      try {
        if (wantUserLookup) {
          const loaded = await loadStoredCredentialForStatus();
          info = { stored: loaded.stored, backend: loaded.backend };
          if (loaded.stored) {
            token = loaded.token;
          }
        } else {
          info = await inspectStoredCredential();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        if (opts.json) {
          process.stdout.write(JSON.stringify({ status: "error", error: message }, null, 2) + "\n");
        } else {
          process.stderr.write(`auth status error: ${message}\n`);
        }
        process.exit(1);
      }

      const userLookupEnabled = info.stored && wantUserLookup;
      let identity: null | GithubIdentitySummary = null;
      if (userLookupEnabled) {
        // inspectGithubIdentity is designed to return null on any failure, but
        // we wrap defensively at the CLI level too: a regression in the wrapper,
        // or a platform-specific fetch error path (e.g. Node 22 on macOS has
        // surfaced uncaught socket rejections from privileged-port ECONNREFUSED),
        // must never break the auth-status command. Status output should always
        // succeed even when the network is broken.
        try {
          identity = await inspectGithubIdentity({ token });
        } catch {
          identity = null;
        }
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              status: info.stored ? "logged_in" : "logged_out",
              stored: info.stored,
              backend: info.backend,
              user: identity
            },
            null,
            2
          ) + "\n"
        );
      } else if (info.stored) {
        process.stdout.write(`${formatHumanAuthStatusLine(info.backend, identity)}\n`);
      } else {
        process.stdout.write("not logged in\n");
      }
      process.exit(info.stored ? 0 : 2);
    });
}
