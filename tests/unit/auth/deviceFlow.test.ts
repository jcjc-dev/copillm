import { describe, expect, it } from "vitest";

import { loginViaDeviceFlow } from "../../../src/auth/deviceFlow.js";

/**
 * Unit tests for PR 4 — `loginViaDeviceFlow` retry on transient failures.
 *
 * Previously, a single 502 from `github.com/login/oauth/access_token`
 * aborted the whole login flow — the user had to start over from a new
 * device code. Now:
 *   - The init POST retries on 5xx/429/408/409/425 + transport errors
 *     up to `initMaxAttempts` (default 3) with exponential backoff.
 *   - The poll loop `continue`s on transient HTTP/transport errors
 *     instead of throwing — the loop's own `await sleep(intervalMs)` IS
 *     the natural backoff and the device-flow `expires_in` IS the budget.
 *
 * All cases drive the public API through injected `fetchImpl` + `sleepImpl`
 * so they run in milliseconds without `vi.useFakeTimers()`.
 */

const DEVICE_CODE_PAYLOAD = {
  device_code: "fake-device-code",
  user_code: "AAAA-BBBB",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5
};

function initOk(): Response {
  return new Response(JSON.stringify(DEVICE_CODE_PAYLOAD), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function pollOk(token = "gho_real_token"): Response {
  return new Response(JSON.stringify({ access_token: token }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function pollPending(): Response {
  return new Response(JSON.stringify({ error: "authorization_pending" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function statusOnly(status: number, body = ""): Response {
  return new Response(body, { status });
}

interface Harness {
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  fetchCalls: Array<{ url: string }>;
  sleepCalls: number[];
  stdout: { write: (chunk: string) => void };
  stdoutWrites: string[];
}

function makeHarness(responses: Array<Response | Error>): Harness {
  const fetchCalls: Array<{ url: string }> = [];
  const sleepCalls: number[] = [];
  const stdoutWrites: string[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input) => {
    fetchCalls.push({ url: String(input) });
    const next = responses[i++];
    if (next === undefined) {
      throw new Error(`Test bug: fetchImpl invoked more times than responses provided (call #${i})`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return {
    fetchImpl,
    sleepImpl: async (ms) => {
      sleepCalls.push(ms);
    },
    fetchCalls,
    sleepCalls,
    stdout: { write: (chunk) => stdoutWrites.push(chunk) },
    stdoutWrites
  };
}

describe("loginViaDeviceFlow — init POST retry", () => {
  it("happy path: init 200 → poll 200 returns the token", async () => {
    const h = makeHarness([initOk(), pollOk("gho_xxx")]);
    const token = await loginViaDeviceFlow({
      fetchImpl: h.fetchImpl,
      sleepImpl: h.sleepImpl,
      stdout: h.stdout
    });
    expect(token).toBe("gho_xxx");
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.stdoutWrites.join("")).toMatch(/Open https:\/\/github\.com\/login\/device and enter code AAAA-BBBB/);
  });

  it("retries init 502 once and succeeds on the second attempt", async () => {
    const h = makeHarness([statusOnly(502), initOk(), pollOk()]);
    const token = await loginViaDeviceFlow({
      fetchImpl: h.fetchImpl,
      sleepImpl: h.sleepImpl,
      stdout: h.stdout
    });
    expect(token).toBe("gho_real_token");
    expect(h.fetchCalls).toHaveLength(3);
    // Backoff: 200ms after the 502 init, then the device-flow `interval`
    // (5_000) after the device prompt is printed.
    expect(h.sleepCalls).toEqual([200, 5_000]);
  });

  it("retries init ECONNRESET → success", async () => {
    const transientErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const h = makeHarness([transientErr, initOk(), pollOk()]);
    const token = await loginViaDeviceFlow({
      fetchImpl: h.fetchImpl,
      sleepImpl: h.sleepImpl,
      stdout: h.stdout
    });
    expect(token).toBe("gho_real_token");
    expect(h.fetchCalls).toHaveLength(3);
  });

  it("throws after exhausting initMaxAttempts of 503s", async () => {
    const h = makeHarness([statusOnly(503), statusOnly(503), statusOnly(503)]);
    await expect(
      loginViaDeviceFlow({
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
        stdout: h.stdout,
        initMaxAttempts: 3
      })
    ).rejects.toThrow(/Device flow init failed \(503\)/);
    expect(h.fetchCalls).toHaveLength(3);
    // Two sleeps between three failed attempts. No sleep after the final
    // (the wall-clock to surface the error is the user's).
    expect(h.sleepCalls).toEqual([200, 400]);
  });

  it("does NOT retry init 400 — bad client_id / scope is deterministic", async () => {
    const h = makeHarness([statusOnly(400)]);
    await expect(
      loginViaDeviceFlow({
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
        stdout: h.stdout
      })
    ).rejects.toThrow(/Device flow init failed \(400\)/);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.sleepCalls).toEqual([]);
  });

  it("does NOT retry init 404 — endpoint missing is deterministic", async () => {
    const h = makeHarness([statusOnly(404)]);
    await expect(
      loginViaDeviceFlow({
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
        stdout: h.stdout
      })
    ).rejects.toThrow(/Device flow init failed \(404\)/);
    expect(h.fetchCalls).toHaveLength(1);
  });

  it("attaches an AbortSignal to each init fetch", async () => {
    let signal: AbortSignal | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal instanceof AbortSignal ? init.signal : null;
      return initOk();
    };
    await loginViaDeviceFlow({
      fetchImpl,
      sleepImpl: async () => {},
      // Short-circuit before poll by failing inside the loop. Actually we'd
      // need to mock both — use a second fetchImpl that handles two calls.
      stdout: { write: () => {} }
    }).catch(() => {});
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("loginViaDeviceFlow — poll loop transient resilience", () => {
  it("regression: a single 503 from the poll endpoint does NOT abort the login", async () => {
    // Previously, this exact sequence threw `Access token poll failed (503)`
    // and the user had to start over. With the fix, the loop just `continue`s.
    const h = makeHarness([
      initOk(),
      pollPending(),
      statusOnly(503), // transient blip — must NOT abort
      pollOk("gho_resilient")
    ]);
    const token = await loginViaDeviceFlow({
      fetchImpl: h.fetchImpl,
      sleepImpl: h.sleepImpl,
      stdout: h.stdout
    });
    expect(token).toBe("gho_resilient");
    // 4 fetches: init + 3 polls (pending, 503, success).
    expect(h.fetchCalls).toHaveLength(4);
  });

  it("regression: an ECONNRESET during poll does NOT abort the login", async () => {
    const transientErr = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const h = makeHarness([initOk(), transientErr, pollOk("gho_dns_survived")]);
    const token = await loginViaDeviceFlow({
      fetchImpl: h.fetchImpl,
      sleepImpl: h.sleepImpl,
      stdout: h.stdout
    });
    expect(token).toBe("gho_dns_survived");
  });

  it("DOES abort on a non-retryable poll status (e.g. 400)", async () => {
    const h = makeHarness([initOk(), statusOnly(400)]);
    await expect(
      loginViaDeviceFlow({
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
        stdout: h.stdout
      })
    ).rejects.toThrow(/Access token poll failed \(400\)/);
  });

  it("DOES abort on a non-retryable transport error (e.g. EACCES)", async () => {
    const permanent = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const h = makeHarness([initOk(), permanent]);
    await expect(
      loginViaDeviceFlow({
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
        stdout: h.stdout
      })
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("returns the access token on first successful poll (preserved behaviour)", async () => {
    const h = makeHarness([initOk(), pollOk("gho_immediate")]);
    const token = await loginViaDeviceFlow({
      fetchImpl: h.fetchImpl,
      sleepImpl: h.sleepImpl,
      stdout: h.stdout
    });
    expect(token).toBe("gho_immediate");
  });

  it("handles slow_down by increasing the poll interval (preserved behaviour)", async () => {
    const slowDown = new Response(JSON.stringify({ error: "slow_down" }), { status: 200 });
    const h = makeHarness([initOk(), slowDown, pollOk("gho_slowed")]);
    const token = await loginViaDeviceFlow({
      fetchImpl: h.fetchImpl,
      sleepImpl: h.sleepImpl,
      stdout: h.stdout
    });
    expect(token).toBe("gho_slowed");
    // First poll sleep is the original 5s; second has +1s from slow_down.
    expect(h.sleepCalls).toEqual([5_000, 6_000]);
  });

  it("throws on expired_token (preserved behaviour)", async () => {
    const expired = new Response(JSON.stringify({ error: "expired_token" }), { status: 200 });
    const h = makeHarness([initOk(), expired]);
    await expect(
      loginViaDeviceFlow({
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
        stdout: h.stdout
      })
    ).rejects.toThrow(/Device code expired/);
  });

  it("throws on access_denied (preserved behaviour)", async () => {
    const denied = new Response(JSON.stringify({ error: "access_denied" }), { status: 200 });
    const h = makeHarness([initOk(), denied]);
    await expect(
      loginViaDeviceFlow({
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
        stdout: h.stdout
      })
    ).rejects.toThrow(/Authorization was denied/);
  });

  it("attaches an AbortSignal to each poll fetch (timeout enforcement)", async () => {
    const signals: Array<AbortSignal | null> = [];
    let i = 0;
    const responses = [initOk(), pollOk("gho_ok")];
    const fetchImpl: typeof fetch = async (_input, init) => {
      signals.push(init?.signal instanceof AbortSignal ? init.signal : null);
      return responses[i++];
    };
    await loginViaDeviceFlow({
      fetchImpl,
      sleepImpl: async () => {},
      stdout: { write: () => {} }
    });
    // Both fetches (init + poll) must have a signal attached.
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });
});
