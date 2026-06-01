import { inspectStoredCredential, saveStoredCredential } from "../../auth/credentials.js";
import { loginViaDeviceFlow } from "../../auth/deviceFlow.js";
import { ensureAuthenticatedInteractive as ensureAuthenticatedInteractiveImpl, type EnsureAuthenticatedDeps } from "../../auth/ensureAuthenticated.js";
import { choose, confirm } from "../../auth/interactivePrompt.js";
import { loadConfig } from "../../config/config.js";
import { describeBackend } from "../shared/backends.js";

/**
 * Build the default dependency bundle for ensureAuthenticatedInteractive.
 * Lives here (rather than inside the auth module) so the auth module stays
 * UI-framework-agnostic and tests can supply alternative implementations.
 */
export function defaultEnsureAuthDeps(): EnsureAuthenticatedDeps {
  return {
    inspectStoredCredential,
    isTty: () => process.stdin.isTTY === true,
    confirm,
    choose,
    loginViaDeviceFlow,
    loadAccountType: () => loadConfig().accountType,
    saveStoredCredential,
    describeBackend,
    print: (line) => process.stdout.write(line),
    setEnv: (key, value) => {
      process.env[key] = value;
    }
  };
}

export async function ensureAuthenticatedInteractive(): Promise<void> {
  return ensureAuthenticatedInteractiveImpl(defaultEnsureAuthDeps());
}
