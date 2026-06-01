import { debugLogPath } from "../../config/home.js";
import { currentDebugLogPath } from "../shared/debug.js";

export function daemonSpawnEnv(debug: boolean): NodeJS.ProcessEnv {
  if (!debug) {
    return process.env;
  }
  return {
    ...process.env,
    COPILLM_LOG_LEVEL: "debug",
    COPILLM_LOG_FILE: currentDebugLogPath(true) ?? debugLogPath()
  };
}
