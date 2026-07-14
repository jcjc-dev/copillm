import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

import { postToCopilot } from "../../../../src/server/upstream/copilotClient.js";
import { CopilotTokenManager } from "../../../../src/auth/copilotToken.js";

/**
 * Direct coverage for `postToCopilot` — the upstream client that owns the
 * retry / forced-refresh / abort orchestration. The retry *primitives* are
 * unit-tested in retryPolicy.test.ts, but the orchestration here (401 →
 * forced token refresh → retry, retryable-status retry with body discard,
 * non-benign transport retry, retry-budget exhaustion, pre-aborted signal)
 * had no direct test. The upstream call goes through the global `fetch`, so we
 * stub that; token refreshes go through an injected token-manager `fetchImpl`.
 */

const logger = pino({ level: "silent" });

function makeTokenManager(initialBearer: string, refreshedBearer: string): { tm: CopilotTokenManager; tokenFetches: () => number } {
  let count = 0;
  const tm = new CopilotTokenManager("gh-token", {
    fetchImpl: (async () => {
      count += 1;
      return new Response(
        JSON.stringify({ token: refreshedBearer, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch
  });
  // Preload a fresh bearer so a non-forced ensureToken returns it without a
  // refresh — the forced refresh on a 401 becomes the only token exchange.
  (tm as unknown as { state: { token: string; expiresAtUnix: number } }).state = {
    token: initialBearer,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600
  };
  return { tm, tokenFetches: () => count };
}

type UpstreamAction = { kind: "respond"; status: number; body?: string } | { kind: "throw"; error: unknown };

function stubUpstream(actions: UpstreamAction[]): {
  calls: Array<{ authorization: string | null; url: string }>;
} {
  const calls: Array<{ authorization: string | null; url: string }> = [];
  let i = 0;
  const mock = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ authorization: init?.headers?.Authorization ?? null, url: String(url) });
    const action = actions[Math.min(i, actions.length - 1)];
    i += 1;
    if (action.kind === "throw") {
      throw action.error;
    }
    return new Response(action.body ?? "{}", {
      status: action.status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", mock);
  return { calls };
}

function call(tm: CopilotTokenManager, signal?: AbortSignal): Promise<Response> {
  return postToCopilot({
    tokenManager: tm,
    accountType: "individual",
    body: { model: "gpt-test", messages: [] },
    requestId: "req-test",
    logger,
    upstreamPath: "/chat/completions",
    signal
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postToCopilot", () => {
  it("forces a token refresh and retries once on a 401, then succeeds with the new bearer", async () => {
    const { tm, tokenFetches } = makeTokenManager("bearer-v1", "bearer-v2");
    const { calls } = stubUpstream([
      { kind: "respond", status: 401 },
      { kind: "respond", status: 200, body: '{"ok":true}' }
    ]);

    const response = await call(tm);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].authorization).toBe("Bearer bearer-v1");
    expect(calls[1].authorization).toBe("Bearer bearer-v2");
    expect(tokenFetches()).toBe(1);
  });

  it("retries a retryable status (429) then returns the successful response", async () => {
    const { tm } = makeTokenManager("bearer-v1", "bearer-v2");
    const { calls } = stubUpstream([
      { kind: "respond", status: 429 },
      { kind: "respond", status: 200 }
    ]);

    const response = await call(tm);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    // No forced refresh on a 429 — the same bearer is reused.
    expect(calls[1].authorization).toBe("Bearer bearer-v1");
  });

  it("retries a non-benign transport error then succeeds", async () => {
    const { tm } = makeTokenManager("bearer-v1", "bearer-v2");
    // ECONNRESET is treated as a benign client-disconnect (not retried), so use
    // a non-benign retryable transport failure: undici's `fetch failed` wrapper
    // carrying an ECONNREFUSED cause.
    const transportError = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const { calls } = stubUpstream([
      { kind: "throw", error: transportError },
      { kind: "respond", status: 200 }
    ]);

    const response = await call(tm);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("rethrows a non-retryable transport error without retrying", async () => {
    const { tm } = makeTokenManager("bearer-v1", "bearer-v2");
    const fatal = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const { calls } = stubUpstream([{ kind: "throw", error: fatal }]);

    await expect(call(tm)).rejects.toThrow("permission denied");
    expect(calls).toHaveLength(1);
  });

  it("exhausts the retry budget on persistent 500s and returns the last response", async () => {
    const { tm } = makeTokenManager("bearer-v1", "bearer-v2");
    const { calls } = stubUpstream([
      { kind: "respond", status: 500 },
      { kind: "respond", status: 500 },
      { kind: "respond", status: 500 }
    ]);

    const response = await call(tm);

    expect(response.status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it("throws an abort error without issuing any request when the signal is already aborted", async () => {
    const { tm } = makeTokenManager("bearer-v1", "bearer-v2");
    const { calls } = stubUpstream([{ kind: "respond", status: 200 }]);

    await expect(call(tm, AbortSignal.abort())).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("routes inference through the account type detected during token exchange", async () => {
    const { tm } = makeTokenManager("bearer-v1", "bearer-v2");
    (tm as unknown as {
      state: { token: string; expiresAtUnix: number; detectedAccountType: "enterprise" };
    }).state = {
      token: "bearer-v1",
      expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
      detectedAccountType: "enterprise"
    };
    const { calls } = stubUpstream([{ kind: "respond", status: 200 }]);

    await postToCopilot({
      tokenManager: tm,
      accountType: "business",
      body: { model: "gpt-test", messages: [] },
      requestId: "req-detected-endpoint",
      logger,
      upstreamPath: "/chat/completions"
    });

    expect(calls[0]?.url).toBe(
      "https://api.enterprise.githubcopilot.com/chat/completions"
    );
  });
});
