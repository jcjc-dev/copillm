import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ModelDiscoveryHttpError,
  ModelDiscoverySchemaError,
  listModels,
  listModelsUnion
} from "../../../src/models/discovery.js";

/**
 * Unit tests for `src/models/discovery.ts` covering PR 3:
 *
 *   Fix 4 — `listModelsUnion` exponential backoff between attempts +
 *           short-circuit on terminal (schema / non-retryable HTTP) errors.
 *   Fix 5 — `canUseCacheFallback` widened to cover 401/403/408 in addition
 *           to the previous 429 + ≥500 set.
 *   Fix 6 — `listModels` `fetch` gets `AbortSignal.timeout(15s)`.
 *
 * All cases drive the public API through injected `fetchImpl` + `sleepImpl`
 * so tests run in milliseconds without polluting wall-clock or relying on
 * `vi.useFakeTimers()`. The cache file is rooted under a per-test temp
 * `COPILLM_HOME` so we never touch the real user home.
 */

const CATALOG = {
  ok: () =>
    new Response(JSON.stringify({ data: [{ id: "fake-model-a" }, { id: "fake-model-b" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
  union: (extra: string) =>
    new Response(JSON.stringify({ data: [{ id: "fake-model-a" }, { id: extra }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
  statusOnly: (status: number) => new Response("upstream", { status })
};

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-discovery-"));
  savedEnv.COPILLM_HOME = process.env.COPILLM_HOME;
  process.env.COPILLM_HOME = tmpHome;
});

afterEach(() => {
  if (savedEnv.COPILLM_HOME === undefined) {
    delete process.env.COPILLM_HOME;
  } else {
    process.env.COPILLM_HOME = savedEnv.COPILLM_HOME;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedCache(): void {
  const cachePayload = {
    version: 1,
    accountType: "individual",
    savedAtIso: new Date().toISOString(),
    models: [{ id: "cached-model-z" }]
  };
  const cachePath = path.join(tmpHome, "models.cache.json");
  fs.writeFileSync(cachePath, JSON.stringify(cachePayload, null, 2), { mode: 0o600 });
}

describe("listModels — Fix 6: AbortSignal.timeout on the upstream fetch", () => {
  it("attaches an AbortSignal to every upstream call", async () => {
    let observedSignal: AbortSignal | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      observedSignal = init?.signal instanceof AbortSignal ? init.signal : null;
      return CATALOG.ok();
    };
    const result = await listModels("individual", "tok", { fetchImpl });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(result.models.length).toBe(2);
  });

  it("aborts within the configured timeout when upstream never responds; falls back to cache if present", async () => {
    seedCache();
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(asAbortError(signal.reason)), { once: true });
      });
    const started = Date.now();
    const result = await listModels("individual", "tok", { fetchImpl, timeoutMs: 30 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    expect(result.source).toBe("cache");
    expect(result.stale).toBe(true);
    expect(result.models[0].id).toBe("cached-model-z");
  });

  it("aborts within timeout and propagates the abort when no cache is present", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(asAbortError(signal.reason)), { once: true });
      });
    const started = Date.now();
    await expect(listModels("individual", "tok", { fetchImpl, timeoutMs: 30 })).rejects.toThrow(
      /no cache snapshot is available/
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("listModels — Fix 5: canUseCacheFallback widened to 401/403/408", () => {
  for (const status of [401, 403, 408, 429, 500, 502, 503, 504]) {
    it(`falls back to cache on HTTP ${status} when a cache snapshot exists`, async () => {
      seedCache();
      const fetchImpl: typeof fetch = async () => CATALOG.statusOnly(status);
      const result = await listModels("individual", "tok", { fetchImpl });
      expect(result.source).toBe("cache");
      expect(result.stale).toBe(true);
      expect(result.models[0].id).toBe("cached-model-z");
    });
  }

  for (const status of [400, 404, 422]) {
    it(`does NOT fall back on HTTP ${status} — deterministic failure even with cache present`, async () => {
      seedCache();
      const fetchImpl: typeof fetch = async () => CATALOG.statusOnly(status);
      await expect(listModels("individual", "tok", { fetchImpl })).rejects.toBeInstanceOf(ModelDiscoveryHttpError);
    });
  }

  it("does NOT fall back on schema errors — deterministic, real cause is more useful", async () => {
    seedCache();
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ not: "a list anywhere" }), { status: 200 });
    await expect(listModels("individual", "tok", { fetchImpl })).rejects.toBeInstanceOf(
      ModelDiscoverySchemaError
    );
  });

  it("falls back on transport errors (AbortError / TypeError) when cache present", async () => {
    seedCache();
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await listModels("individual", "tok", { fetchImpl });
    expect(result.source).toBe("cache");
  });

  it("preserved behaviour: rethrows with `no cache snapshot is available` when fallback eligible but cache missing", async () => {
    const fetchImpl: typeof fetch = async () => CATALOG.statusOnly(503);
    await expect(listModels("individual", "tok", { fetchImpl })).rejects.toThrow(
      /no cache snapshot is available/
    );
  });
});

describe("listModelsUnion — Fix 4: exponential backoff between attempts", () => {
  it("happy path: succeeds on every attempt, no sleep (sleeps only on failure)", async () => {
    const sleepCalls: number[] = [];
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return CATALOG.ok();
    };
    const result = await listModelsUnion("individual", "tok", 3, {
      fetchImpl,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      }
    });
    expect(result.source).toBe("live");
    // listModelsUnion's contract is "run N attempts and union the results"
    // — preserved from the original. Sleeps only happen between FAILED
    // attempts (the regression: before this PR, the loop sleep-free even
    // on burst 429s).
    expect(fetchCount).toBe(3);
    expect(sleepCalls).toEqual([]);
  });

  it("sleeps 200ms then 400ms between three failing attempts", async () => {
    const sleepCalls: number[] = [];
    const fetchImpl: typeof fetch = async () => CATALOG.statusOnly(503);
    await expect(
      listModelsUnion("individual", "tok", 3, {
        fetchImpl,
        sleepImpl: async (ms) => {
          sleepCalls.push(ms);
        }
      })
    ).rejects.toThrow(/no cache snapshot is available/);
    // Two backoff sleeps: between attempts 1→2 and 2→3. No sleep after the
    // final attempt — that's the user's wall-clock to get back the answer.
    expect(sleepCalls).toEqual([200, 400]);
  });

  it("sleeps only between failed attempts; a success between failures resets the backoff counter", async () => {
    // Use 400 (non-retryable, non-cache-fallback eligible) — BUT 400 would
    // short-circuit the loop entirely. Instead use 503 with NO cache so
    // `listModels` re-throws "no cache snapshot is available" up to the
    // union loop, where the 503 inside is still in the retryable set and
    // the loop continues.
    //
    // Pattern: fail, success, fail.
    //   after attempt 1 (fail)     → sleep 200ms (1st consecutive failure)
    //   after attempt 2 (success)  → no sleep (counter reset to 0)
    //   no sleep after attempt 3   (final attempt, even though it failed)
    const sleepCalls: number[] = [];
    let i = 0;
    const fetchImpl: typeof fetch = async () => {
      i += 1;
      if (i === 1 || i === 3) return CATALOG.statusOnly(503);
      return CATALOG.ok();
    };
    const result = await listModelsUnion("individual", "tok", 3, {
      fetchImpl,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      }
    });
    expect(result.models.length).toBeGreaterThan(0);
    // `result.source` may be "live" or "cache" depending on whether attempt
    // 3's 503 happens to find a cache written by attempt 2 (it usually does).
    // What matters here is the SLEEP SCHEDULE, not the final source.
    // The key invariant: NO sleep after the success between two failures.
    expect(sleepCalls).toEqual([200]);
  });

  it("unions distinct model ids across multiple attempts (preserved behaviour)", async () => {
    seedCache();
    let i = 0;
    // Each attempt returns a different model id; results merge into the union.
    const fetchImpl: typeof fetch = async () => {
      i += 1;
      if (i === 1) return CATALOG.ok(); // a + b
      if (i === 2) return CATALOG.union("fake-model-c"); // a + c
      return CATALOG.union("fake-model-d"); // a + d
    };
    const result = await listModelsUnion("individual", "tok", 3, {
      fetchImpl,
      sleepImpl: async () => {}
    });
    const ids = result.models.map((m) => m.id).sort();
    expect(ids).toEqual(["fake-model-a", "fake-model-b", "fake-model-c", "fake-model-d"]);
  });
});

describe("listModelsUnion — Fix 4: short-circuit on terminal errors", () => {
  it("does NOT retry a schema failure — exactly one fetch", async () => {
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ rubbish: true }), { status: 200 });
    };
    await expect(
      listModelsUnion("individual", "tok", 3, { fetchImpl, sleepImpl: async () => {} })
    ).rejects.toBeInstanceOf(ModelDiscoverySchemaError);
    expect(fetchCount).toBe(1);
  });

  it("does NOT retry a 404 — exactly one fetch (and surfaces the real status)", async () => {
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return CATALOG.statusOnly(404);
    };
    // No cache exists, so the inner cache-fallback re-throws the HTTP error
    // through, and the union loop short-circuits on the non-retryable status.
    await expect(
      listModelsUnion("individual", "tok", 3, { fetchImpl, sleepImpl: async () => {} })
    ).rejects.toBeInstanceOf(ModelDiscoveryHttpError);
    expect(fetchCount).toBe(1);
  });

  it("DOES retry a 503 (status is in the retryable set)", async () => {
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return CATALOG.statusOnly(503);
    };
    await expect(
      listModelsUnion("individual", "tok", 3, { fetchImpl, sleepImpl: async () => {} })
    ).rejects.toThrow(/no cache snapshot is available/);
    expect(fetchCount).toBe(3);
  });

  it("retries 503 then succeeds on the second attempt", async () => {
    let i = 0;
    const fetchImpl: typeof fetch = async () => {
      i += 1;
      if (i === 1) return CATALOG.statusOnly(503);
      return CATALOG.ok();
    };
    const result = await listModelsUnion("individual", "tok", 3, {
      fetchImpl,
      sleepImpl: async () => {}
    });
    expect(result.source).toBe("live");
    expect(result.models.length).toBe(2);
  });
});

describe("error type identity — pins exported classes for downstream consumers", () => {
  it("ModelDiscoveryHttpError carries the status field", async () => {
    const fetchImpl: typeof fetch = async () => CATALOG.statusOnly(404);
    const err = await listModels("individual", "tok", { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDiscoveryHttpError);
    expect((err as ModelDiscoveryHttpError).status).toBe(404);
  });

  it("ModelDiscoverySchemaError is distinct from ModelDiscoveryHttpError", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ rubbish: true }), { status: 200 });
    const err = await listModels("individual", "tok", { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDiscoverySchemaError);
    expect(err).not.toBeInstanceOf(ModelDiscoveryHttpError);
  });
});

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error("Aborted");
  (err as { name: string }).name = "AbortError";
  return err;
}
