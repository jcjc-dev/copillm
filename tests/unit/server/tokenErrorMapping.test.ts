import { describe, expect, it } from "vitest";

import {
  CopilotTokenExchangeError,
  CopilotTokenPayloadError,
  CopilotTokenExpiredError,
  CopilotTokenManagerError
} from "../../../src/auth/copilotToken.js";
import { tokenErrorToHttpResponse, healthFailure } from "../../../src/server/errors.js";

/**
 * Unit tests for PR 5 / Fix 10: shared `tokenErrorToHttpResponse` helper.
 *
 * Was: `routes/models.ts` collapsed every `CopilotTokenManagerError` to a
 * flat `503 token_refresh_failed`. Calling agents (codex, pi, claude) could
 * not distinguish a revoked-token (permanent, 401) from a rate-limit
 * (transient, 429) or upstream blip (5xx) — they blindly retried even on
 * the permanent case.
 *
 * Now: the discrimination logic lives in `errors.ts` as a shared helper
 * used by both `healthFailure` (the existing consumer) and the new
 * `routes/models.ts` mapping. These tests pin the contract.
 */

describe("tokenErrorToHttpResponse", () => {
  it("maps CopilotTokenExchangeError(401) → HTTP 401 github_auth_invalid", () => {
    const err = new CopilotTokenExchangeError("Copilot token exchange failed (401).", 401, "Bad credentials");
    const r = tokenErrorToHttpResponse(err);
    expect(r.httpStatus).toBe(401);
    expect(r.payload).toEqual({
      status: "unauthenticated",
      error: "github_auth_invalid",
      upstream_status_code: 401
    });
  });

  it("maps CopilotTokenExchangeError(403) → HTTP 401 github_auth_invalid", () => {
    const err = new CopilotTokenExchangeError("Copilot token exchange failed (403).", 403, "Forbidden");
    const r = tokenErrorToHttpResponse(err);
    expect(r.httpStatus).toBe(401);
    expect(r.payload).toEqual({
      status: "unauthenticated",
      error: "github_auth_invalid",
      upstream_status_code: 403
    });
  });

  it("maps CopilotTokenExchangeError(503) → HTTP 503 token_exchange_failed", () => {
    const err = new CopilotTokenExchangeError("Copilot token exchange failed (503).", 503, "");
    const r = tokenErrorToHttpResponse(err);
    expect(r.httpStatus).toBe(503);
    expect(r.payload).toEqual({
      status: "upstream_unreachable",
      error: "token_exchange_failed",
      upstream_status_code: 503
    });
  });

  it("maps CopilotTokenExchangeError(429) → HTTP 503 token_exchange_failed (transient)", () => {
    const err = new CopilotTokenExchangeError("Copilot token exchange failed (429).", 429, "");
    const r = tokenErrorToHttpResponse(err);
    expect(r.httpStatus).toBe(503);
    expect(r.payload.error).toBe("token_exchange_failed");
  });

  it("maps CopilotTokenPayloadError → HTTP 401 token_refresh_failed", () => {
    const err = new CopilotTokenPayloadError("Token exchange response was missing required fields.");
    const r = tokenErrorToHttpResponse(err);
    expect(r.httpStatus).toBe(401);
    expect(r.payload).toEqual({
      status: "unauthenticated",
      error: "token_refresh_failed"
    });
  });

  it("maps CopilotTokenExpiredError → HTTP 401 token_refresh_failed", () => {
    const err = new CopilotTokenExpiredError("Received near-expired Copilot token.");
    const r = tokenErrorToHttpResponse(err);
    expect(r.httpStatus).toBe(401);
    expect(r.payload.error).toBe("token_refresh_failed");
  });

  it("maps a plain CopilotTokenManagerError → HTTP 401 token_refresh_failed", () => {
    const err = new CopilotTokenManagerError("misc auth failure");
    const r = tokenErrorToHttpResponse(err);
    expect(r.httpStatus).toBe(401);
    expect(r.payload.error).toBe("token_refresh_failed");
  });

  it("maps an unrelated Error → HTTP 503 token_refresh_unavailable", () => {
    const err = new Error("network unreachable");
    const r = tokenErrorToHttpResponse(err);
    expect(r.httpStatus).toBe(503);
    expect(r.payload).toEqual({
      status: "upstream_unreachable",
      error: "token_refresh_unavailable"
    });
  });

  it("maps null/undefined → HTTP 503 token_refresh_unavailable (defensive)", () => {
    expect(tokenErrorToHttpResponse(null).httpStatus).toBe(503);
    expect(tokenErrorToHttpResponse(undefined).httpStatus).toBe(503);
  });
});

describe("healthFailure (preserved behaviour — now delegates to tokenErrorToHttpResponse)", () => {
  it("produces the same shape as tokenErrorToHttpResponse for every error class", () => {
    const errors: Array<unknown> = [
      new CopilotTokenExchangeError("a", 401, ""),
      new CopilotTokenExchangeError("b", 403, ""),
      new CopilotTokenExchangeError("c", 502, ""),
      new CopilotTokenPayloadError("d"),
      new CopilotTokenExpiredError("e"),
      new CopilotTokenManagerError("f"),
      new Error("g"),
      null,
      undefined
    ];
    for (const err of errors) {
      expect(healthFailure(err)).toEqual(tokenErrorToHttpResponse(err));
    }
  });
});
