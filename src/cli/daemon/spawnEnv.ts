import { debugLogPath } from "../../config/home.js";
import { currentDebugLogPath } from "../shared/debug.js";

export function daemonSpawnEnv(debug: boolean, options?: { port?: number | null }): NodeJS.ProcessEnv {
  // Always return a fresh object so callers that inject a port (e.g. `restart`
  // pinning the daemon back onto its previous port) never mutate the live
  // `process.env`.
  const env: NodeJS.ProcessEnv = debug
    ? {
        ...process.env,
        COPILLM_LOG_LEVEL: "debug",
        COPILLM_LOG_FILE: currentDebugLogPath(true) ?? debugLogPath()
      }
    : { ...process.env };
  if (options?.port != null) {
    env.COPILLM_PORT = String(options.port);
  }
  return env;
}
