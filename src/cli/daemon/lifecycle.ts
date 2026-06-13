import { setTimeout as sleep } from "node:timers/promises";
import { inspectLock } from "../../server/lock.js";

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sendSignalIfAlive(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

export async function stopByPid(pid: number): Promise<void> {
  if (!sendSignalIfAlive(pid, "SIGTERM")) {
    return;
  }
  const stopDeadline = Date.now() + 8_000;
  while (Date.now() < stopDeadline) {
    const lockState = inspectLock();
    if (lockState.state !== "running" || lockState.lock.pid !== pid) {
      return;
    }
    await sleep(150);
  }

  if (!sendSignalIfAlive(pid, "SIGKILL")) {
    return;
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline) {
    const lockState = inspectLock();
    if (lockState.state !== "running" || lockState.lock.pid !== pid) {
      return;
    }
    await sleep(100);
  }

  throw new Error(`Failed to stop daemon pid ${pid}.`);
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timeoutPromise = sleep(timeoutMs).then(() => {
    throw new Error(message);
  });
  return Promise.race([promise, timeoutPromise]);
}

export function computeUptimeSeconds(startedAtIso: string): null | number {
  const startedMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startedMs)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
}

/**
 * Render an uptime duration (in seconds) as a compact human-readable string
 * broken down into days, hours, minutes, and seconds — e.g. `2d 3h 15m 9s`.
 *
 * Leading zero-value units are dropped so short uptimes stay terse
 * (`45s`, `5m 2s`). Sub-minute and zero durations fall back to a seconds
 * component so the result is never empty (`0s`). Negative or non-finite
 * inputs clamp to `0s`.
 */
export function formatUptime(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

