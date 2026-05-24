import type { IncomingMessage, ServerResponse } from "node:http";
import type { Writable } from "node:stream";
import type { Logger } from "pino";

// Node error codes we treat as "client went away, this is normal" — they
// must never crash the daemon and must not be reported as errors. SSE clients
// (Codex, Claude Code, pi) abort streams constantly: user types another
// prompt, hits Esc, switches turns, etc.
const BENIGN_SOCKET_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_HTTP_HEADERS_SENT"
]);

export function isBenignSocketError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: unknown; name?: unknown; cause?: unknown };
  if (typeof err.code === "string" && BENIGN_SOCKET_ERROR_CODES.has(err.code)) {
    return true;
  }
  if (err.name === "AbortError") {
    return true;
  }
  if (err.cause && isBenignSocketError(err.cause)) {
    return true;
  }
  return false;
}

export interface RequestLifecycle {
  /**
   * Aborts when the downstream client disconnects (close/error/abort) so we
   * can cancel the in-flight upstream `fetch` and stop wasting Copilot quota.
   */
  signal: AbortSignal;
  /**
   * True until the response is finished OR the client has gone away. Use this
   * to decide whether further writes/headers will succeed.
   */
  isAlive: () => boolean;
}

export function attachRequestLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  requestId: string
): RequestLifecycle {
  const controller = new AbortController();
  let alive = true;

  const markGone = (source: "close" | "error" | "aborted", err?: unknown) => {
    if (!alive) {
      return;
    }
    alive = false;
    if (err && !isBenignSocketError(err)) {
      logger.debug(
        { event: "request_lifecycle_error", request_id: requestId, source, err },
        "request stream errored"
      );
    } else if (source !== "close" || err) {
      logger.debug(
        { event: "request_lifecycle_closed", request_id: requestId, source },
        "client disconnected"
      );
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  res.on("close", () => markGone("close"));
  res.on("error", (err) => markGone("error", err));
  req.on("aborted", () => markGone("aborted"));
  req.on("error", (err) => markGone("error", err));

  return {
    signal: controller.signal,
    isAlive: () => alive && res.writable && !res.writableEnded
  };
}

/**
 * Writes a JSON response, but is a no-op when the response is already
 * committed or the socket is gone. This is the safe replacement for
 * `res.setHeader(...) + res.end(...)` in any path that might run after a
 * streaming response has started flushing.
 */
export function safeSendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || !res.writable || res.writableEnded) {
    return;
  }
  try {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  } catch (error) {
    if (isBenignSocketError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Best-effort write to a downstream Writable. Returns false when the chunk
 * could not be delivered (because the stream is destroyed or the write
 * threw a benign socket error). Non-benign errors are re-thrown so they're
 * still visible to the caller.
 */
export function safeWrite(downstream: Writable, chunk: string): boolean {
  if (!downstream.writable || downstream.writableEnded || downstream.destroyed) {
    return false;
  }
  try {
    return downstream.write(chunk);
  } catch (error) {
    if (isBenignSocketError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Best-effort end of a downstream Writable. Swallows benign socket errors;
 * never throws on a destroyed stream.
 */
export function safeEnd(downstream: Writable): void {
  if (downstream.writableEnded || downstream.destroyed) {
    return;
  }
  try {
    downstream.end();
  } catch (error) {
    if (isBenignSocketError(error)) {
      return;
    }
    throw error;
  }
}
