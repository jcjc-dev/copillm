import type { Logger } from "pino";

import { isBenignSocketError } from "../server/requestLifecycle.js";

/**
 * Install a process-level safety net for the daemon. When an unexpected
 * `uncaughtException` or `unhandledRejection` escapes the per-request error
 * handling, we log it loudly and keep the process alive. A daemon dying on
 * a per-request bug is strictly worse than continuing to serve the next
 * request: clients (Codex, Claude Code, pi) lose ALL in-flight streams when
 * the process exits, and the user has to manually `copillm start` again.
 *
 * Benign socket errors (ECONNRESET / EPIPE / ERR_STREAM_DESTROYED / aborted
 * fetches) are downgraded to debug — they're a normal part of SSE life and
 * would otherwise spam the logs.
 *
 * Returns a disposer that uninstalls the handlers (used by tests).
 */
export function installProcessSafetyNet(logger: Logger): () => void {
  const onUncaught = (error: unknown): void => {
    if (isBenignSocketError(error)) {
      logger.debug(
        { event: "process_safety_net", kind: "uncaught_exception", err: toErrLike(error) },
        "swallowed benign socket error at process level"
      );
      return;
    }
    logger.error(
      { event: "process_safety_net", kind: "uncaught_exception", err: toErrLike(error) },
      "uncaught exception in daemon — keeping process alive"
    );
  };

  const onUnhandled = (reason: unknown): void => {
    if (isBenignSocketError(reason)) {
      logger.debug(
        { event: "process_safety_net", kind: "unhandled_rejection", err: toErrLike(reason) },
        "swallowed benign socket rejection at process level"
      );
      return;
    }
    logger.error(
      { event: "process_safety_net", kind: "unhandled_rejection", err: toErrLike(reason) },
      "unhandled promise rejection in daemon — keeping process alive"
    );
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
  };
}

function toErrLike(value: unknown): { type: string; message: string; stack?: string; code?: string } {
  if (value instanceof Error) {
    const out: { type: string; message: string; stack?: string; code?: string } = {
      type: value.name,
      message: value.message
    };
    if (value.stack) out.stack = value.stack;
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string") out.code = code;
    return out;
  }
  return { type: typeof value, message: String(value) };
}
