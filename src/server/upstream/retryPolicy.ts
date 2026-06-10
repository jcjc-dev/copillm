// Shared retry primitives for upstream HTTP calls.
//
// Originally lived inline in `copilotClient.ts` only. Extracted so that
// other upstream-facing fetch sites (token exchange in `auth/copilotToken.ts`,
// future device-flow / model-discovery sites) can share the same policy
// instead of each rolling its own slightly-different version. The numerical
// constants and the retryable-status set must match `copilotClient.ts`'s
// previous behaviour exactly so existing tests and production semantics
// don't drift.

/**
 * HTTP statuses that warrant a retry: transient server-side congestion /
 * upstream outages. 401 is NOT here — auth failures are handled by a
 * separate caller-driven "force refresh once" path in `copilotClient.ts`,
 * and by `CopilotTokenManager.exchange()` as a terminal "bad credentials"
 * signal.
 */
export const RETRYABLE_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 425, 429, 500, 502, 503, 504
]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_UPSTREAM_STATUSES.has(status);
}

/** Base exponential backoff: 200ms × 2^(attempt-1). */
export const BASE_BACKOFF_MS = 200;

export function retryDelayMs(attempt: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
}

/**
 * Node `fetch` / undici transport error codes worth retrying. Excludes
 * permanent errors like EACCES, ENOSPC, certificate failures. Both the
 * direct `error.code` and the wrapped `error.cause.code` are checked
 * because undici wraps the underlying socket error in a `TypeError:
 * fetch failed` whose `.cause` carries the real code.
 *
 * EAI_AGAIN, EHOSTUNREACH, ENETUNREACH catch the common transient DNS
 * and routing failures (home networks, corp VPN flaps, macOS wake-from-
 * sleep). UND_ERR_* are undici's own timeouts and socket errors.
 */
const RETRYABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);

const RETRYABLE_TRANSPORT_MESSAGE_SUBSTRINGS: readonly string[] = [
  "timed out",
  "timeout",
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
  "ehostunreach",
  "enetunreach",
  "socket hang up",
  "other side closed",
  "fetch failed"
];

export function isRetryableTransportError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const typedError = error as Error & { code?: string; cause?: unknown };

  if (matchesRetryableCode(typedError.code)) {
    return true;
  }
  // Recurse into .cause to handle undici's `TypeError: fetch failed` wrapper
  // (and any other wrapper layers); bounded depth so a self-referential
  // cause chain can't run away.
  if (causeHasRetryableCode(typedError.cause, 0)) {
    return true;
  }

  if (!(typedError instanceof Error)) {
    return false;
  }
  const message = typedError.message.toLowerCase();
  return RETRYABLE_TRANSPORT_MESSAGE_SUBSTRINGS.some((needle) => message.includes(needle));
}

function matchesRetryableCode(code: undefined | string): boolean {
  if (typeof code !== "string") return false;
  return RETRYABLE_TRANSPORT_CODES.has(code.toUpperCase());
}

function causeHasRetryableCode(cause: unknown, depth: number): boolean {
  if (!cause || typeof cause !== "object" || depth > 5) {
    return false;
  }
  const inner = cause as { code?: string; cause?: unknown };
  if (matchesRetryableCode(inner.code)) {
    return true;
  }
  return causeHasRetryableCode(inner.cause, depth + 1);
}
