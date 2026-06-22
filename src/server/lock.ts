import fs from "node:fs";
import { readFileSync } from "node:fs";
import { getCopillmHome, lockPath, lockReadPath } from "../config/home.js";
import type { LockFileData } from "../types/index.js";
import { ensureSecureCopillmDirectory, writeFileSecureAtomic } from "../config/fsSecurity.js";

export class LockAlreadyRunningError extends Error {
  public constructor(public readonly lock: LockFileData) {
    super(`copillm is already running (pid ${lock.pid}, port ${lock.port}).`);
    this.name = "LockAlreadyRunningError";
  }
}

export type LockInspection =
  | { state: "missing" }
  | { state: "running"; lock: LockFileData }
  | { state: "stale"; reason: string; lock: null | LockFileData };

export async function acquireLock(
  port: number,
  options?: {
    isRunning?: (lock: LockFileData) => Promise<boolean>;
  }
): Promise<void> {
  await acquireLockWithRetry(port, options, false);
}

async function acquireLockWithRetry(
  port: number,
  options: undefined | { isRunning?: (lock: LockFileData) => Promise<boolean> },
  alreadyRetried: boolean
): Promise<void> {
  const file = lockPath();
  ensureSecureCopillmDirectory(getCopillmHome());
  const data: LockFileData = {
    pid: process.pid,
    port,
    started_at_iso: new Date().toISOString()
  };
  try {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
    writeFileSecureAtomic(file, JSON.stringify(data, null, 2), 0o600);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as { code?: string }).code !== "EEXIST") {
      throw error;
    }
  }

  const inspection = inspectLock();
  if (inspection.state === "running") {
    if (options?.isRunning && (await options.isRunning(inspection.lock))) {
      throw new LockAlreadyRunningError(inspection.lock);
    }
    if (alreadyRetried) {
      throw new Error("Unable to acquire lock after removing stale lock.");
    }
    tryUnlinkLock();
    await acquireLockWithRetry(port, options, true);
    return;
  }

  if (alreadyRetried) {
    const reason = inspection.state === "stale" ? inspection.reason : "lock_exists";
    throw new Error(`Unable to acquire lock: ${reason}`);
  }
  tryUnlinkLock();
  await acquireLockWithRetry(port, options, true);
}

export function releaseLock(): void {
  tryUnlinkLock();
}

export function inspectLock(): LockInspection {
  const file = lockReadPath();
  if (!fs.existsSync(file)) {
    return { state: "missing" };
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    return { state: "stale", reason: `failed_to_read_lock: ${errorMessage(error)}`, lock: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { state: "stale", reason: "lock_json_invalid", lock: null };
  }

  const lock = parseLockFileData(parsed);
  if (!lock) {
    return { state: "stale", reason: "lock_schema_invalid", lock: null };
  }

  const alive = processAlive(lock.pid);
  if (!alive) {
    return { state: "stale", reason: "pid_not_alive", lock };
  }
  return { state: "running", lock };
}

export function readLock(): null | LockFileData {
  const inspection = inspectLock();
  if (inspection.state !== "running") {
    return null;
  }
  return inspection.lock;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) {
      throw error;
    }
    const code = (error as { code?: string }).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function tryUnlinkLock(): void {
  const file = lockPath();
  if (!fs.existsSync(file)) {
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
}

function parseLockFileData(input: unknown): null | LockFileData {
  if (!input || typeof input !== "object") {
    return null;
  }
  const obj = input as Partial<LockFileData>;
  if (
    typeof obj.pid !== "number" ||
    !Number.isInteger(obj.pid) ||
    obj.pid <= 0 ||
    typeof obj.port !== "number" ||
    !Number.isInteger(obj.port) ||
    obj.port < 1 ||
    obj.port > 65535 ||
    typeof obj.started_at_iso !== "string" ||
    obj.started_at_iso.length === 0
  ) {
    return null;
  }
  return {
    pid: obj.pid,
    port: obj.port,
    started_at_iso: obj.started_at_iso
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}
