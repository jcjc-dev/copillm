import { setTimeout as sleep } from "node:timers/promises";
import { inspectLock } from "../../server/lock.js";
import type { LockFileData } from "../../types/index.js";
import { isPidAlive } from "./lifecycle.js";

export async function probeLivez(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/livez`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function probeDebugEndpoint(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_debug`, { signal: AbortSignal.timeout(1_200) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function warnIfDebugRequestedButInactive(debugRequested: boolean, port: number): Promise<boolean> {
  if (!debugRequested) {
    return false;
  }
  const active = await probeDebugEndpoint(port);
  if (!active) {
    process.stderr.write(
      `warning: copillm is already running without debug mode; run \`copillm stop\` then \`copillm --debug start --detach\` to enable daemon diagnostics.\n`
    );
  }
  return active;
}

export async function probeHealth(port: number): Promise<{
  ok: boolean;
  bearerTtlSeconds: null | number;
  statusCode: null | number;
  status: null | string;
  error: null | string;
}> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_500) });
    const payload = (await response.json()) as {
      bearer_ttl_seconds?: unknown;
      status?: unknown;
      error?: unknown;
    };
    return {
      ok: response.ok,
      statusCode: response.status,
      status: typeof payload.status === "string" ? payload.status : null,
      error: typeof payload.error === "string" ? payload.error : null,
      bearerTtlSeconds: response.ok && typeof payload.bearer_ttl_seconds === "number" ? payload.bearer_ttl_seconds : null
    };
  } catch {
    return { ok: false, bearerTtlSeconds: null, statusCode: null, status: null, error: "health_probe_failed" };
  }
}

export async function readLiveLock(): Promise<null | LockFileData> {
  const lockState = inspectLock();
  if (lockState.state !== "running") {
    return null;
  }
  return (await probeLivez(lockState.lock.port)) ? lockState.lock : null;
}

export async function waitForDaemonReady(
  pid: null | number,
  timeoutMs: number
): Promise<null | { pid: number; port: number }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const lockState = inspectLock();
    if (lockState.state === "running" && (await probeLivez(lockState.lock.port))) {
      return { pid: lockState.lock.pid, port: lockState.lock.port };
    }
    if (pid !== null && !isPidAlive(pid)) {
      return null;
    }
    await sleep(150);
  }
  return null;
}
