import { setTimeout as defaultSleep } from "node:timers/promises";
import { inspectLock } from "../../server/lock.js";
import type { LockFileData } from "../../types/index.js";
import { isPidAlive } from "./lifecycle.js";

/**
 * Retry helper for loopback fetches. Localhost RTT is sub-millisecond on a
 * healthy daemon, so a 100ms inter-attempt sleep is enough to give a freshly
 * spawned process time to bind, while still keeping total wall-clock for a
 * "probe + 2 retries" sequence well under a second.
 *
 * Only AbortError + transport-class errors trigger retries — a 4xx/5xx
 * response from the daemon is a real signal (the route exists but
 * disagrees with us), and retrying just delays the answer the caller
 * needs to surface. The set is narrow on purpose: we don't want to retry
 * ECONNREFUSED forever on a daemon that genuinely isn't running.
 */
const LOOPBACK_PROBE_BACKOFF_MS = 100;

interface ProbeRetryOptions {
  attempts?: number;
  backoffMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

async function probeWithRetry<T>(
  attempt: () => Promise<{ ok: T; failed: false } | { ok: null; failed: true; error: unknown }>,
  options: ProbeRetryOptions = {}
): Promise<{ ok: T; failed: false } | { ok: null; failed: true; error: unknown }> {
  const maxAttempts = Math.max(1, options.attempts ?? 3);
  const sleepImpl = options.sleepImpl ?? ((ms) => defaultSleep(ms));
  const backoffMs = options.backoffMs ?? LOOPBACK_PROBE_BACKOFF_MS;
  let last: { ok: null; failed: true; error: unknown } = { ok: null, failed: true, error: undefined };
  for (let i = 0; i < maxAttempts; i += 1) {
    const result = await attempt();
    if (!result.failed) {
      return result;
    }
    last = result;
    if (!isRetryableProbeError(result.error)) {
      return result;
    }
    if (i < maxAttempts - 1) {
      await sleepImpl(backoffMs);
    }
  }
  return last;
}

function isRetryableProbeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const typed = error as Error & { code?: string; cause?: { code?: string } };
  if (typed.name === "AbortError" || typed.name === "TimeoutError") return true;
  const code = typed.code?.toUpperCase() ?? typed.cause?.code?.toUpperCase();
  // ECONNREFUSED *is* retried here even though it usually means "nothing
  // listening": a daemon racing to bind right after spawn returns
  // ECONNREFUSED for a tiny window, and probes do call us from spawn-adjacent
  // paths (`waitForDaemonReady` polls; `acquireLock`'s isRunning callback
  // checks an existing lock). The 100ms inter-attempt sleep is enough for
  // the bind race to settle.
  return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT";
}

export async function probeLivez(port: number, options?: ProbeRetryOptions): Promise<boolean> {
  const result = await probeWithRetry<boolean>(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/livez`, { signal: AbortSignal.timeout(800) });
      return { ok: response.ok, failed: false };
    } catch (error) {
      return { ok: null, failed: true, error };
    }
  }, options);
  return result.failed ? false : result.ok;
}

export async function probeDebugEndpoint(port: number, options?: ProbeRetryOptions): Promise<boolean> {
  const result = await probeWithRetry<boolean>(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_debug`, { signal: AbortSignal.timeout(1_200) });
      return { ok: response.ok, failed: false };
    } catch (error) {
      return { ok: null, failed: true, error };
    }
  }, options);
  return result.failed ? false : result.ok;
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

export interface HealthProbeResult {
  ok: boolean;
  bearerTtlSeconds: null | number;
  statusCode: null | number;
  status: null | string;
  error: null | string;
  /**
   * Version of the running daemon process, as reported by `/healthz`.
   * `null` when the daemon is older than the field's introduction (in which
   * case status falls back to "version: unknown") or when the response is
   * malformed.
   */
  version: null | string;
}

export async function probeHealth(port: number, options?: ProbeRetryOptions): Promise<HealthProbeResult> {
  const result = await probeWithRetry<HealthProbeResult>(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_500) });
      const payload = (await response.json()) as {
        bearer_ttl_seconds?: unknown;
        status?: unknown;
        error?: unknown;
        version?: unknown;
      };
      return {
        ok: {
          ok: response.ok,
          statusCode: response.status,
          status: typeof payload.status === "string" ? payload.status : null,
          error: typeof payload.error === "string" ? payload.error : null,
          bearerTtlSeconds: response.ok && typeof payload.bearer_ttl_seconds === "number" ? payload.bearer_ttl_seconds : null,
          version: typeof payload.version === "string" && payload.version.length > 0 ? payload.version : null
        },
        failed: false as const
      };
    } catch (error) {
      return { ok: null, failed: true as const, error };
    }
  }, options);
  return result.failed
    ? { ok: false, bearerTtlSeconds: null, statusCode: null, status: null, error: "health_probe_failed", version: null }
    : result.ok;
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
  timeoutMs: number,
  options?: { sleepImpl?: (ms: number) => Promise<void> }
): Promise<null | { pid: number; port: number }> {
  const sleepImpl = options?.sleepImpl ?? ((ms) => defaultSleep(ms));
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const lockState = inspectLock();
    // Use a single-attempt probe inside this poll loop — the outer 150ms
    // loop already retries naturally. Letting `probeLivez` retry internally
    // here would compound delays.
    if (lockState.state === "running" && (await probeLivez(lockState.lock.port, { attempts: 1 }))) {
      return { pid: lockState.lock.pid, port: lockState.lock.port };
    }
    if (pid !== null && !isPidAlive(pid)) {
      return null;
    }
    await sleepImpl(150);
  }
  return null;
}
