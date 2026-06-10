import { describe, expect, it } from "vitest";

import {
  CopilotTokenManager,
  CopilotTokenExchangeError,
  CopilotTokenPayloadError
} from "../../../src/auth/copilotToken.js";

/**
 * Unit tests for `CopilotTokenManager.exchange()` retry + timeout behaviour.
 *
 * The manager exposes a `fetchImpl` + `sleepImpl` DI seam (mirroring
 * `src/cli/updateNotifier.ts`'s pattern) so tests can drive every retry
 * branch deterministically without `vi.useFakeTimers()` or
 * `vi.stubGlobal("fetch", ...)`. `sleepImpl` resolves immediately so the
 * test suite stays fast — wall-clock backoff is irrelevant for correctness.
 *
 * Each test exercises the public `ensureToken()` rather than the private
 * `exchange()` so we go through the real `refreshInFlight` dedupe.
 */

const VALID_FUTURE_EXP = Math.floor(Date.now() / 1000) + 3_600;

function okResponse(): Response {
  return new Response(JSON.stringify({ token: "bearer-xyz", expires_at: VALID_FUTURE_EXP }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function statusResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

interface ManagerHarness {
  manager: CopilotTokenManager;
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  sleepCalls: number[];
}

function makeManager(
  responses: Array<Response | Error>,
  options?: { maxAttempts?: number; attemptTimeoutMs?: number }
): ManagerHarness {
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sleepCalls: number[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    const next = responses[i++];
    if (next === undefined) {
      throw new Error(`Test bug: fetchImpl invoked more times than responses provided (call #${i})`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  const manager = new CopilotTokenManager("gho_test_oauth", {
    fetchImpl,
    sleepImpl: async (ms) => {
      sleepCalls.push(ms);
    },
    maxAttempts: options?.maxAttempts ?? 3,
    attemptTimeoutMs: options?.attemptTimeoutMs ?? 10_000
  });
  return { manager, fetchCalls, sleepCalls };
}

describe("CopilotTokenManager.exchange — retry policy", () => {
  it("returns the bearer on first-attempt 200 with no sleep", async () => {
    const { manager, fetchCalls, sleepCalls } = makeManager([okResponse()]);
    await expect(manager.ensureToken()).resolves.toBe("bearer-xyz");
    expect(fetchCalls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  it("retries a 503 once, succeeds on the second attempt, sleeps 200ms between", async () => {
    const { manager, fetchCalls, sleepCalls } = makeManager([statusResponse(503), okResponse()]);
    await expect(manager.ensureToken()).resolves.toBe("bearer-xyz");
    expect(fetchCalls).toHaveLength(2);
    expect(sleepCalls).toEqual([200]);
  });

  it("retries 429 with exponential backoff 200ms then 400ms across 3 attempts", async () => {
    const { manager, fetchCalls, sleepCalls } = makeManager([statusResponse(429), statusResponse(429), okResponse()]);
    await expect(manager.ensureToken()).resolves.toBe("bearer-xyz");
    expect(fetchCalls).toHaveLength(3);
    expect(sleepCalls).toEqual([200, 400]);
  });

  it("throws CopilotTokenExchangeError after maxAttempts of 503s — no sleep after the final attempt", async () => {
    const { manager, fetchCalls, sleepCalls } = makeManager([statusResponse(503), statusResponse(503), statusResponse(503)]);
    await expect(manager.ensureToken()).rejects.toBeInstanceOf(CopilotTokenExchangeError);
    expect(fetchCalls).toHaveLength(3);
    // Two sleeps: between attempts 1→2 and 2→3. None after attempt 3.
    expect(sleepCalls).toEqual([200, 400]);
  });

  it("retries every status in the upstream-shared retryable set", async () => {
    // Exercise each retryable status. For each one, the policy must retry
    // at least once. Using a 2-attempt budget keeps the test compact.
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
      const { manager, fetchCalls } = makeManager([statusResponse(status), okResponse()], { maxAttempts: 2 });
      await expect(manager.ensureToken()).resolves.toBe("bearer-xyz");
      expect(fetchCalls, `status ${status} should retry`).toHaveLength(2);
    }
  });
});

describe("CopilotTokenManager.exchange — terminal credential statuses", () => {
  it("does NOT retry on 401 — fast-fails so the user sees an actionable signal", async () => {
    const { manager, fetchCalls, sleepCalls } = makeManager([statusResponse(401, "Bad credentials")]);
    const err = await manager.ensureToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CopilotTokenExchangeError);
    expect((err as CopilotTokenExchangeError).statusCode).toBe(401);
    expect(fetchCalls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  it("does NOT retry on 403", async () => {
    const { manager, fetchCalls } = makeManager([statusResponse(403)]);
    await expect(manager.ensureToken()).rejects.toMatchObject({ statusCode: 403 });
    expect(fetchCalls).toHaveLength(1);
  });

  it("does NOT retry on 404", async () => {
    const { manager, fetchCalls } = makeManager([statusResponse(404)]);
    await expect(manager.ensureToken()).rejects.toMatchObject({ statusCode: 404 });
    expect(fetchCalls).toHaveLength(1);
  });

  it("propagates the upstream body snippet (truncated to 256 chars) on terminal failure", async () => {
    const longBody = "x".repeat(500);
    const { manager } = makeManager([statusResponse(401, longBody)]);
    const err = await manager.ensureToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CopilotTokenExchangeError);
    expect((err as CopilotTokenExchangeError).responseBodySnippet.length).toBe(256);
  });
});

describe("CopilotTokenManager.exchange — transport errors", () => {
  it("retries ECONNRESET and succeeds on the next attempt", async () => {
    const transientErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const { manager, fetchCalls, sleepCalls } = makeManager([transientErr, okResponse()]);
    await expect(manager.ensureToken()).resolves.toBe("bearer-xyz");
    expect(fetchCalls).toHaveLength(2);
    expect(sleepCalls).toEqual([200]);
  });

  it("retries EAI_AGAIN (DNS soft-fail) — the case the original classifier MISSED", async () => {
    const dnsFlake = Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.com"), {
      code: "EAI_AGAIN"
    });
    const { manager, fetchCalls } = makeManager([dnsFlake, okResponse()]);
    await expect(manager.ensureToken()).resolves.toBe("bearer-xyz");
    expect(fetchCalls).toHaveLength(2);
  });

  it("retries an undici-wrapped TypeError whose .cause carries ECONNRESET", async () => {
    const cause = Object.assign(new Error("inner"), { code: "ECONNRESET" });
    const outer = new TypeError("fetch failed");
    (outer as { cause: unknown }).cause = cause;
    const { manager, fetchCalls } = makeManager([outer, okResponse()]);
    await expect(manager.ensureToken()).resolves.toBe("bearer-xyz");
    expect(fetchCalls).toHaveLength(2);
  });

  it("retries based on message substring when neither code nor cause is set", async () => {
    const { manager, fetchCalls } = makeManager([new Error("request timed out"), okResponse()]);
    await expect(manager.ensureToken()).resolves.toBe("bearer-xyz");
    expect(fetchCalls).toHaveLength(2);
  });

  it("propagates non-retryable transport errors immediately (e.g. EACCES)", async () => {
    const permanent = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const { manager, fetchCalls } = makeManager([permanent]);
    await expect(manager.ensureToken()).rejects.toMatchObject({ code: "EACCES" });
    expect(fetchCalls).toHaveLength(1);
  });

  it("rethrows the last transport error after exhausting attempts", async () => {
    const flake = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const { manager, fetchCalls, sleepCalls } = makeManager([flake, flake, flake]);
    await expect(manager.ensureToken()).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(fetchCalls).toHaveLength(3);
    expect(sleepCalls).toEqual([200, 400]);
  });
});

describe("CopilotTokenManager.exchange — per-attempt timeout", () => {
  it("attaches an AbortSignal to every fetch invocation", async () => {
    const { manager, fetchCalls } = makeManager([okResponse()]);
    await manager.ensureToken();
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts when the per-attempt timeout elapses; the AbortError surfaces as a transport failure", async () => {
    // attemptTimeoutMs is short. The fake fetch waits longer than the timeout
    // and listens on the abort signal to reject with DOMException("AbortError").
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(asAbortError(signal.reason));
          return;
        }
        signal?.addEventListener("abort", () => reject(asAbortError(signal.reason)), { once: true });
      });

    const manager = new CopilotTokenManager("gho_test", {
      fetchImpl: slowFetch,
      sleepImpl: async () => {},
      attemptTimeoutMs: 25,
      maxAttempts: 1
    });

    const started = Date.now();
    const err = await manager.ensureToken().catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    // The fetch must have been aborted (some flavour of AbortError or DOMException).
    // We don't assert the exact constructor — Node's AbortSignal.timeout produces
    // DOMException in some versions, plain Error in others — but the bound matters.
    expect(err).toBeDefined();
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("CopilotTokenManager — payload validation (preserved behaviour)", () => {
  it("throws CopilotTokenPayloadError when the body is missing required fields", async () => {
    const badBody = new Response(JSON.stringify({ token: "" }), { status: 200 });
    const { manager } = makeManager([badBody]);
    await expect(manager.ensureToken()).rejects.toBeInstanceOf(CopilotTokenPayloadError);
  });

  it("throws CopilotTokenPayloadError on non-finite expires_at", async () => {
    const badBody = new Response(JSON.stringify({ token: "x", expires_at: "soon" }), { status: 200 });
    const { manager } = makeManager([badBody]);
    await expect(manager.ensureToken()).rejects.toBeInstanceOf(CopilotTokenPayloadError);
  });
});

describe("CopilotTokenManager.ensureToken — in-flight dedupe (preserved behaviour)", () => {
  it("two concurrent ensureToken calls share one fetch chain", async () => {
    const { manager, fetchCalls } = makeManager([okResponse()]);
    const [a, b] = await Promise.all([manager.ensureToken(), manager.ensureToken()]);
    expect(a).toBe("bearer-xyz");
    expect(b).toBe("bearer-xyz");
    expect(fetchCalls).toHaveLength(1);
  });

  it("a second call after success returns the cached token without re-fetching", async () => {
    const { manager, fetchCalls } = makeManager([okResponse()]);
    await manager.ensureToken();
    await manager.ensureToken();
    expect(fetchCalls).toHaveLength(1);
  });

  it("after clear(), the next ensureToken triggers a fresh exchange", async () => {
    const { manager, fetchCalls } = makeManager([okResponse(), okResponse()]);
    await manager.ensureToken();
    manager.clear();
    await manager.ensureToken();
    expect(fetchCalls).toHaveLength(2);
  });
});

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error("Aborted");
  (err as { name: string }).name = "AbortError";
  return err;
}
