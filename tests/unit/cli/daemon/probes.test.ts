import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { probeHealth, probeLivez, probeDebugEndpoint } from "../../../../src/cli/daemon/probes.js";

/**
 * Unit tests for PR 5 / Fix 8: loopback probe retry + error structure.
 *
 * Three probe functions (`probeLivez`, `probeDebugEndpoint`, `probeHealth`)
 * previously did one fetch each and gave up on the first ECONNRESET / abort.
 * That false-negative had real consequences:
 *   - `warnIfDebugRequestedButInactive` told users to stop+restart a
 *     perfectly healthy daemon.
 *   - `probeLivez` is wired into `acquireLock`'s `isRunning` callback —
 *     a false negative makes the lock acquirer delete a healthy daemon's
 *     lockfile.
 *
 * The new `probeWithRetry` helper does 3 attempts with 100ms inter-attempt
 * sleeps, retrying ONLY on AbortError / transport errors (not on a real
 * HTTP response). Total wall-clock for a retry sequence stays under 500ms
 * because the per-fetch AbortSignal timeouts are tight (800ms / 1.2s / 1.5s).
 *
 * Tests use a real loopback `http.createServer` so we exercise the actual
 * `fetch` path — no `vi.stubGlobal('fetch')`. Sleep is faked via dep
 * injection to keep the suite fast.
 */

let server: http.Server | null = null;
let port = 0;
let requestCount = 0;
let handler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;

beforeEach(async () => {
  requestCount = 0;
  handler = null;
  server = http.createServer((req, res) => {
    requestCount += 1;
    if (handler) {
      handler(req, res);
    } else {
      res.statusCode = 404;
      res.end("no handler");
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server!.address() as AddressInfo).port;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  vi.restoreAllMocks();
});

describe("probeLivez — retry behaviour", () => {
  it("returns true on a single 200 (no retry needed)", async () => {
    handler = (_req, res) => {
      res.statusCode = 200;
      res.end("{}");
    };
    await expect(probeLivez(port, { attempts: 3 })).resolves.toBe(true);
    expect(requestCount).toBe(1);
  });

  it("returns false fast on ECONNREFUSED — but still retries the configured budget", async () => {
    // Close the server so connections refuse.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const sleepCalls: number[] = [];
    const started = Date.now();
    const result = await probeLivez(port, {
      attempts: 3,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      }
    });
    const elapsed = Date.now() - started;
    expect(result).toBe(false);
    // 3 attempts → 2 inter-attempt sleeps (no sleep after the final).
    expect(sleepCalls).toEqual([100, 100]);
    // Without real wall-clock sleeps, the loop should finish in well under
    // the loopback fetch timeout of 800ms × 3.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("returns false on a 4xx response WITHOUT retrying (real HTTP signal, not a transport blip)", async () => {
    handler = (_req, res) => {
      res.statusCode = 503;
      res.end("");
    };
    const sleepCalls: number[] = [];
    const result = await probeLivez(port, {
      attempts: 3,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      }
    });
    expect(result).toBe(false);
    // The retry happens via probeWithRetry. A response (even non-OK) is a
    // "success" path — we don't retry, we just return `response.ok`.
    expect(requestCount).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  it("succeeds on the second attempt when the first request connects but stalls past the 800ms timeout", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      if (calls === 1) {
        // Stall forever; the per-fetch 800ms AbortSignal fires.
        // No response — connection sits there.
      } else {
        res.statusCode = 200;
        res.end("{}");
      }
    };
    // Don't fake sleep — let the 100ms backoff happen naturally; entire test
    // should still finish under 2s thanks to the 800ms per-attempt timeout.
    const started = Date.now();
    const result = await probeLivez(port, { attempts: 3 });
    const elapsed = Date.now() - started;
    expect(result).toBe(true);
    expect(requestCount).toBe(2);
    // First attempt times out at 800ms, then 100ms backoff, then success.
    expect(elapsed).toBeGreaterThan(800);
    expect(elapsed).toBeLessThan(2_500);
  }, 5_000);
});

describe("probeDebugEndpoint — retry behaviour", () => {
  it("returns true on first 200", async () => {
    handler = (_req, res) => {
      res.statusCode = 200;
      res.end("{}");
    };
    await expect(probeDebugEndpoint(port, { attempts: 3 })).resolves.toBe(true);
    expect(requestCount).toBe(1);
  });

  it("returns false on 404 (debug endpoint not mounted), no retry", async () => {
    handler = (_req, res) => {
      res.statusCode = 404;
      res.end("");
    };
    const result = await probeDebugEndpoint(port, { attempts: 3, sleepImpl: async () => {} });
    expect(result).toBe(false);
    expect(requestCount).toBe(1);
  });
});

describe("probeHealth — structured failure on transport error (Fix 8 regression guard)", () => {
  it("returns a fully-typed result on success", async () => {
    handler = (_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "ok", bearer_ttl_seconds: 1234 }));
    };
    const result = await probeHealth(port, { attempts: 1 });
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.status).toBe("ok");
    expect(result.bearerTtlSeconds).toBe(1234);
    expect(result.error).toBeNull();
  });

  it("returns `error: 'health_probe_failed'` on transport failure (does not throw)", async () => {
    // Close the server to force ECONNREFUSED.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const result = await probeHealth(port, { attempts: 1, sleepImpl: async () => {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("health_probe_failed");
    expect(result.statusCode).toBeNull();
    expect(result.bearerTtlSeconds).toBeNull();
  });

  it("preserves the upstream payload's status + error fields when present", async () => {
    handler = (_req, res) => {
      res.statusCode = 503;
      res.end(JSON.stringify({ status: "upstream_unreachable", error: "token_exchange_failed" }));
    };
    const result = await probeHealth(port, { attempts: 1 });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.status).toBe("upstream_unreachable");
    expect(result.error).toBe("token_exchange_failed");
    expect(result.bearerTtlSeconds).toBeNull();
  });
});
