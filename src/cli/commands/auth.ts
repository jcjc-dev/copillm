import type { Command } from "commander";
import { inspectStoredCredential } from "../../auth/credentials.js";
import { inspectGithubIdentity, type GithubIdentitySummary } from "../../auth/githubIdentity.js";
import { ensureAuthenticatedInteractive } from "../auth/ensure.js";
import { runAuthLogin, runAuthLogout } from "../auth/runAuth.js";
import { formatHumanAuthStatusLine } from "../shared/backends.js";
import { emitDeprecation } from "../shared/deprecation.js";

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
    // Undocumented test seam: force the session-only backend regardless of
    // whether the OS keychain is available. Equivalent to setting
    // COPILLM_FORCE_SESSION_BACKEND=1 for the duration of this command.
    .option("--force-session", "(test-only) force the session-only backend", false)
    .action(async (opts: { json?: boolean; forceSession?: boolean }) => {
      await runAuthLogin(opts, { forceSession: Boolean(opts.forceSession) });
    });

  auth
    .command("logout")
    .description("Clear credentials and stop running daemon")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      await runAuthLogout(opts);
    });

  auth
    .command("status")
    .description("Report whether a credential is stored (token is never printed)")
    .option("--json", "JSON output")
    .option("--no-user", "Skip the GitHub /user lookup that fetches the login name")
    .action(async (opts: { json?: boolean; user?: boolean }) => {
      let info: Awaited<ReturnType<typeof inspectStoredCredential>>;
      try {
        info = await inspectStoredCredential();
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        if (opts.json) {
          process.stdout.write(JSON.stringify({ status: "error", error: message }, null, 2) + "\n");
        } else {
          process.stderr.write(`auth status error: ${message}\n`);
        }
        process.exit(1);
      }

      // commander's --no-user toggles opts.user to false; when the flag is
      // omitted opts.user is undefined and we treat that as "fetch by default".
      const userLookupEnabled = info.stored && opts.user !== false;
      let identity: null | GithubIdentitySummary = null;
      if (userLookupEnabled) {
        // inspectGithubIdentity is designed to return null on any failure, but
        // we wrap defensively at the CLI level too: a regression in the wrapper,
        // or a platform-specific fetch error path (e.g. Node 22 on macOS has
        // surfaced uncaught socket rejections from privileged-port ECONNREFUSED),
        // must never break the auth-status command. Status output should always
        // succeed even when the network is broken.
        try {
          identity = await inspectGithubIdentity();
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
