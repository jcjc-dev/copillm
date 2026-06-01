import type { Command } from "commander";
import type { Logger } from "pino";
import { debugLogPath } from "../../config/home.js";

// The root Command and root logger are constructed in cli/index.ts and
// registered here so any command module can resolve "is debug globally on?"
// without taking a Command parameter through every call. This preserves the
// previous behavior where helpers reached for the module-level `program` and
// `logger` directly.

let rootProgram: Command | null = null;
let rootLogger: Logger | null = null;

export function setRootProgram(program: Command): void {
  rootProgram = program;
}

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

export function getRootLogger(): Logger {
  if (!rootLogger) {
    throw new Error("Root logger not initialized — cli/index.ts must call setRootLogger() first.");
  }
  return rootLogger;
}

function getGlobalDebug(): boolean {
  if (!rootProgram) {
    return false;
  }
  return Boolean(rootProgram.opts<{ debug?: boolean }>().debug);
}

export function resolveCopillmDebug(commandDebug?: boolean): boolean {
  return Boolean(commandDebug) || getGlobalDebug();
}

export function enableRuntimeDebug(debug: boolean): void {
  if (!debug) {
    return;
  }
  process.env.COPILLM_LOG_LEVEL = "debug";
  if (rootLogger) {
    rootLogger.level = "debug";
  }
}

export function currentDebugLogPath(debug: boolean): null | string {
  if (!debug) {
    return null;
  }
  return process.env.COPILLM_LOG_FILE ?? debugLogPath();
}
