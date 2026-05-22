import type { AccountType } from "../types/index.js";
import type { CredentialBackend, SaveMode } from "./credentials.js";

/**
 * Injectable dependencies for ensureAuthenticatedInteractive. Extracted so
 * the function is unit-testable without spinning up the full CLI module or
 * touching the real keychain / device flow / TTY.
 *
 * The defaults wired up in cli.ts preserve production behaviour exactly;
 * tests pass mock implementations to exercise individual branches.
 */
export interface EnsureAuthenticatedDeps {
  inspectStoredCredential: () => Promise<{ stored: boolean }>;
  isTty: () => boolean;
  confirm: (question: string) => Promise<boolean>;
  choose: (
    prompt: string,
    choices: Array<{ key: string; label: string; value: "plaintext" | "session" | "cancel" }>
  ) => Promise<"plaintext" | "session" | "cancel">;
  loginViaDeviceFlow: () => Promise<string>;
  loadAccountType: () => AccountType;
  saveStoredCredential: (
    token: string,
    accountType: AccountType,
    options?: { mode?: SaveMode }
  ) => Promise<CredentialBackend>;
  describeBackend: (backend: null | CredentialBackend) => string;
  print: (line: string) => void;
  setEnv: (key: string, value: string) => void;
}

/**
 * If no credential is stored, prompts the user to log in interactively. After
 * a successful device flow, decides where to put the token: keychain (if
 * available), or prompts plaintext / session / cancel.
 *
 * Caller is responsible for checking !opts.detach — this function assumes a
 * TTY-attached foreground process and will throw if stdin is not a TTY when
 * a prompt is needed.
 */
export async function ensureAuthenticatedInteractive(deps: EnsureAuthenticatedDeps): Promise<void> {
  const existing = await deps.inspectStoredCredential();
  if (existing.stored) {
    return;
  }

  if (!deps.isTty()) {
    throw new Error("Not authenticated and stdin is not a TTY. Run `copillm auth login` first.");
  }

  deps.print("You are not logged in. copillm needs a GitHub OAuth token to talk to Copilot.\n");
  const wantsLogin = await deps.confirm("Log in now?");
  if (!wantsLogin) {
    throw new Error("Aborted. Run `copillm auth login` when you're ready.");
  }

  const token = await deps.loginViaDeviceFlow();
  const accountType = deps.loadAccountType();

  // Try the normal save path first (keychain or pre-existing plaintext file).
  // If that's not viable, fall back to an explicit user choice.
  try {
    const backend = await deps.saveStoredCredential(token, accountType);
    deps.print(`Credentials stored via ${deps.describeBackend(backend)}.\n`);
    return;
  } catch {
    // Falls through to the explicit-choice prompt below. We swallow the
    // specific error because the user is about to choose a path anyway.
  }

  deps.print("OS keychain is unavailable on this machine. Choose where to store the token:\n");
  const choice = await deps.choose(
    "  (p) plaintext file at ~/.copillm/credentials.json   (s) in-memory for this session only   (c) cancel",
    [
      { key: "p", label: "plaintext", value: "plaintext" },
      { key: "s", label: "session", value: "session" },
      { key: "c", label: "cancel", value: "cancel" }
    ]
  );

  if (choice === "cancel") {
    throw new Error("Login aborted.");
  }

  if (choice === "session") {
    await deps.saveStoredCredential(token, accountType, { mode: "session" });
    deps.print("Token kept in memory only — you'll need to log in again when this process exits.\n");
    return;
  }

  // choice === "plaintext" — allow the plaintext fallback explicitly for this
  // process. The credentials module checks this env var at save time.
  deps.setEnv("COPILLM_ALLOW_PLAINTEXT_CREDENTIALS", "1");
  await deps.saveStoredCredential(token, accountType);
  deps.print("Credentials stored via credentials file.\n");
}
