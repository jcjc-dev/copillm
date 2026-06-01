import { clearStoredCredential, saveStoredCredential } from "../../auth/credentials.js";
import { loginViaDeviceFlow } from "../../auth/deviceFlow.js";
import { loadConfig } from "../../config/config.js";
import { inspectLock, releaseLock } from "../../server/lock.js";
import { stopByPid } from "../daemon/lifecycle.js";
import { describeBackend } from "../shared/backends.js";
import { writeCommandOutput } from "../shared/output.js";

export async function runAuthLogin(
  opts: { json?: boolean },
  options: { forceSession: boolean }
): Promise<void> {
  if (options.forceSession) {
    process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  }
  const config = loadConfig();
  const token = await loginViaDeviceFlow();
  const saveMode = options.forceSession ? "session" : "auto";
  const backend = await saveStoredCredential(token, config.accountType, { mode: saveMode });
  writeCommandOutput(opts, `Login succeeded. Credentials stored via ${describeBackend(backend)}.`, {
    status: "ok",
    action: "login",
    credential_backend: backend
  });
}

export async function runAuthLogout(opts: { json?: boolean }): Promise<void> {
  const result = await clearStoredCredential();
  const lockState = inspectLock();
  if (lockState.state === "running") {
    await stopByPid(lockState.lock.pid);
  } else if (lockState.state === "stale") {
    releaseLock();
  }

  const credentialStatus = result.removed ? "removed" : "not present";
  writeCommandOutput(opts, `Logged out. Credentials ${credentialStatus} from ${describeBackend(result.backend)}.`, {
    status: "ok",
    action: "logout",
    credential_backend: result.backend,
    credential_removed: result.removed
  });
}
