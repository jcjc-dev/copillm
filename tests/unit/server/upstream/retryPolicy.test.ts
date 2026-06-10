import { describe, expect, it } from "vitest";

import {
  RETRYABLE_UPSTREAM_STATUSES,
  isRetryableStatus,
  isRetryableTransportError,
  retryDelayMs
} from "../../../../src/server/upstream/retryPolicy.js";

/**
 * Unit tests for the shared retry primitives in
 * `src/server/upstream/retryPolicy.ts`.
 *
 * The primitives were extracted from `copilotClient.ts` so that
 * `auth/copilotToken.ts` and other upstream callers could share them.
 * These tests pin the contract — same statuses, same backoff curve, same
 * (now WIDENED) transport-error classification — so future edits can't
 * silently drift one consumer away from the others.
 */

describe("retryDelayMs — exponential backoff curve", () => {
  it("produces 200ms / 400ms / 800ms for attempts 1 / 2 / 3", () => {
    expect(retryDelayMs(1)).toBe(200);
    expect(retryDelayMs(2)).toBe(400);
    expect(retryDelayMs(3)).toBe(800);
  });

  it("clamps non-positive attempts to the base delay (defensive)", () => {
    expect(retryDelayMs(0)).toBe(200);
    expect(retryDelayMs(-5)).toBe(200);
  });
});

describe("isRetryableStatus / RETRYABLE_UPSTREAM_STATUSES", () => {
  it("includes the canonical transient-server statuses", () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status), `status ${status} should be retryable`).toBe(true);
    }
  });

  it("excludes 401/403/404 — those are terminal credential signals, not blips", () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(isRetryableStatus(status), `status ${status} must NOT be retryable`).toBe(false);
    }
  });

  it("excludes 2xx success codes", () => {
    for (const status of [200, 201, 204]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it("RETRYABLE_UPSTREAM_STATUSES is the exact set required by both copilotClient and copilotToken consumers", () => {
    expect(new Set(RETRYABLE_UPSTREAM_STATUSES)).toEqual(new Set([408, 409, 425, 429, 500, 502, 503, 504]));
  });
});

describe("isRetryableTransportError — widened codes vs the previous implementation", () => {
  it("classifies the original three codes (ECONNRESET / ECONNREFUSED / ETIMEDOUT) as retryable — regression guard against narrowing", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]) {
      const err = Object.assign(new Error(`code=${code}`), { code });
      expect(isRetryableTransportError(err), code).toBe(true);
    }
  });

  it("classifies newly-added codes (EAI_AGAIN / EHOSTUNREACH / ENETUNREACH / EPIPE) as retryable", () => {
    for (const code of ["EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]) {
      const err = Object.assign(new Error(`code=${code}`), { code });
      expect(isRetryableTransportError(err), code).toBe(true);
    }
  });

  it("classifies undici socket/timeout codes as retryable", () => {
    for (const code of ["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
      const err = Object.assign(new Error(`code=${code}`), { code });
      expect(isRetryableTransportError(err), code).toBe(true);
    }
  });

  it("normalizes lowercase codes (defensive)", () => {
    const err = Object.assign(new Error("hang up"), { code: "econnreset" });
    expect(isRetryableTransportError(err)).toBe(true);
  });

  it("recurses into .cause to handle undici's TypeError('fetch failed') wrapper", () => {
    const inner = Object.assign(new Error("inner"), { code: "ECONNRESET" });
    const outer = new TypeError("fetch failed");
    (outer as { cause: unknown }).cause = inner;
    expect(isRetryableTransportError(outer)).toBe(true);
  });

  it("recurses two levels deep into nested .cause chains", () => {
    const deepest = Object.assign(new Error("dns"), { code: "EAI_AGAIN" });
    const mid = new Error("middle");
    (mid as { cause: unknown }).cause = deepest;
    const outer = new TypeError("fetch failed");
    (outer as { cause: unknown }).cause = mid;
    expect(isRetryableTransportError(outer)).toBe(true);
  });

  it("falls back to message-substring matching for errors with no code field", () => {
    for (const message of [
      "request timed out",
      "operation timeout",
      "ECONNRESET while reading body",
      "socket hang up",
      "other side closed",
      "getaddrinfo ENOTFOUND api.github.com",
      "EAI_AGAIN flap"
    ]) {
      expect(isRetryableTransportError(new Error(message)), message).toBe(true);
    }
  });

  it("returns false for permanent / non-transport errors", () => {
    expect(isRetryableTransportError(new Error("validation failed"))).toBe(false);
    expect(isRetryableTransportError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(isRetryableTransportError(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe(false);
  });

  it("returns false for non-Error / nullish inputs", () => {
    expect(isRetryableTransportError(null)).toBe(false);
    expect(isRetryableTransportError(undefined)).toBe(false);
    expect(isRetryableTransportError("string error")).toBe(false);
    expect(isRetryableTransportError({ code: "ECONNRESET" })).toBe(true); // plain object with code still counts
  });

  it("bounds .cause recursion to avoid runaway on self-referential chains", () => {
    const self: { code?: string; cause?: unknown } = { code: "EACCES" };
    self.cause = self;
    // No retryable code in the chain; recursion must terminate without throwing.
    expect(isRetryableTransportError(self)).toBe(false);
  });
});
