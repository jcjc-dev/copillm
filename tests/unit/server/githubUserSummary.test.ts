import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GithubUserFetchError,
  clearGithubUserCache,
  getGithubUserSummary
} from "../../../src/server/debugInfo.js";

/**
 * Unit tests for PR 5 / Fix 9: retry + timeout on the GitHub `/user` lookup.
 *
 * Was: single fetch, single attempt. A transient 502 from `api.github.com/user`
 * caused `auth status` to hide the user's login and `/_debug` to report
 * `user_error: github_user_lookup_failed_502` instead of the user object.
 *
 * Now: retries 5xx/429/408/409/425 + transient transport errors up to
 * `maxAttempts` (default 3) with exponential backoff. Fast-fails 401/403/404.
 * The 5-minute response cache is preserved; only successful responses are
 * cached.
 */

beforeEach(() => {
  clearGithubUserCache();
});

afterEach(() => {
  clearGithubUserCache();
  vi.restoreAllMocks();
});

function userOk(login = "testuser"): Response {
  return new Response(
    JSON.stringify({
      login,
      id: 12345,
      name: "Test User",
      email: null,
      type: "User",
      avatar_url: "https://example.invalid/a.png",
      html_url: "https://github.com/testuser",
      plan: { name: "free" }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function statusOnly(status: number, body = ""): Response {
  return new Response(body, { status });
}

function makeFetch(responses: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: number;
} {
  let i = 0;
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    const next = responses[i++];
    if (next === undefined) {
      throw new Error(`Test bug: fetchImpl invoked more times than responses provided (call #${i})`);
    }
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    fetchImpl,
    get calls() {
      return calls;
    }
  };
}

describe("getGithubUserSummary — retry on transient failures (Fix 9)", () => {
  it("happy path: 200 returns the parsed summary in one fetch", async () => {
    const f = makeFetch([userOk("alice")]);
    const summary = await getGithubUserSummary("tok", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} });
    expect(summary.login).toBe("alice");
    expect(summary.plan_name).toBe("free");
    expect(f.calls).toBe(1);
  });

  it("retries 502 once and succeeds on the second attempt", async () => {
    const sleepCalls: number[] = [];
    const f = makeFetch([statusOnly(502), userOk()]);
    const summary = await getGithubUserSummary("tok", {
      fetchImpl: f.fetchImpl,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      }
    });
    expect(summary.login).toBe("testuser");
    expect(f.calls).toBe(2);
    expect(sleepCalls).toEqual([200]);
  });

  it("retries 503 → 503 → 200 across three attempts with exponential backoff", async () => {
    const sleepCalls: number[] = [];
    const f = makeFetch([statusOnly(503), statusOnly(503), userOk()]);
    const summary = await getGithubUserSummary("tok", {
      fetchImpl: f.fetchImpl,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      }
    });
    expect(summary.login).toBe("testuser");
    expect(f.calls).toBe(3);
    expect(sleepCalls).toEqual([200, 400]);
  });

  it("throws GithubUserFetchError after exhausting maxAttempts of 503s", async () => {
    const f = makeFetch([statusOnly(503), statusOnly(503), statusOnly(503)]);
    const err = await getGithubUserSummary("tok", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(GithubUserFetchError);
    expect((err as GithubUserFetchError).status).toBe(503);
    expect(f.calls).toBe(3);
  });

  it("does NOT retry 401 — bad token is terminal", async () => {
    const f = makeFetch([statusOnly(401, "Bad credentials")]);
    const err = await getGithubUserSummary("tok", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(GithubUserFetchError);
    expect((err as GithubUserFetchError).status).toBe(401);
    expect(f.calls).toBe(1);
  });

  it("does NOT retry 403", async () => {
    const f = makeFetch([statusOnly(403)]);
    await expect(
      getGithubUserSummary("tok", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} })
    ).rejects.toMatchObject({ status: 403 });
    expect(f.calls).toBe(1);
  });

  it("does NOT retry 404", async () => {
    const f = makeFetch([statusOnly(404)]);
    await expect(
      getGithubUserSummary("tok", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} })
    ).rejects.toMatchObject({ status: 404 });
    expect(f.calls).toBe(1);
  });

  it("retries ECONNRESET and succeeds on the next attempt", async () => {
    const transientErr = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const f = makeFetch([transientErr, userOk()]);
    const summary = await getGithubUserSummary("tok", {
      fetchImpl: f.fetchImpl,
      sleepImpl: async () => {}
    });
    expect(summary.login).toBe("testuser");
    expect(f.calls).toBe(2);
  });

  it("propagates non-retryable transport errors immediately", async () => {
    const permanent = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const f = makeFetch([permanent]);
    await expect(
      getGithubUserSummary("tok", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} })
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(f.calls).toBe(1);
  });
});

describe("getGithubUserSummary — cache preservation (regression guard)", () => {
  it("returns the cached summary on a second call without re-fetching", async () => {
    const f = makeFetch([userOk("charlie"), userOk("changed-but-cached")]);
    const first = await getGithubUserSummary("tok", { fetchImpl: f.fetchImpl });
    const second = await getGithubUserSummary("tok", { fetchImpl: f.fetchImpl });
    expect(first.login).toBe("charlie");
    expect(second.login).toBe("charlie");
    expect(f.calls).toBe(1);
  });

  it("only caches on success — a 502 followed by 200 results in one cache entry from the 200", async () => {
    const f = makeFetch([statusOnly(502), userOk("dave")]);
    const result = await getGithubUserSummary("tok", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} });
    expect(result.login).toBe("dave");
    expect(f.calls).toBe(2);

    // Subsequent call hits the cache, not the network.
    const f2 = makeFetch([userOk("never-used")]);
    const cached = await getGithubUserSummary("tok", { fetchImpl: f2.fetchImpl });
    expect(cached.login).toBe("dave");
    expect(f2.calls).toBe(0);
  });

  it("clearGithubUserCache() forces a re-fetch on the next call", async () => {
    const f = makeFetch([userOk("eve"), userOk("eve-refreshed")]);
    await getGithubUserSummary("tok", { fetchImpl: f.fetchImpl });
    clearGithubUserCache();
    const second = await getGithubUserSummary("tok", { fetchImpl: f.fetchImpl });
    expect(second.login).toBe("eve-refreshed");
    expect(f.calls).toBe(2);
  });
});

describe("getGithubUserSummary — timeoutMs is plumbed through to AbortSignal", () => {
  it("attaches an AbortSignal when timeoutMs is set", async () => {
    let observedSignal: AbortSignal | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      observedSignal = init?.signal instanceof AbortSignal ? init.signal : null;
      return userOk();
    };
    await getGithubUserSummary("tok", { fetchImpl, timeoutMs: 4_000 });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  it("does NOT attach an AbortSignal when timeoutMs is unset", async () => {
    let observedSignal: AbortSignal | null | undefined = "sentinel" as unknown as AbortSignal;
    const fetchImpl: typeof fetch = async (_input, init) => {
      observedSignal = init?.signal instanceof AbortSignal ? init.signal : null;
      return userOk();
    };
    await getGithubUserSummary("tok", { fetchImpl });
    expect(observedSignal).toBeNull();
  });
});

describe("getGithubUserSummary — cache is keyed by token (multi-account)", () => {
  // A token-aware fetch: returns a different login per `Authorization: token X`.
  function tokenAwareFetch(map: Record<string, string>): { fetchImpl: typeof fetch; calls: number } {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      const token = auth.replace(/^token\s+/, "");
      const login = map[token];
      if (!login) return statusOnly(404);
      return userOk(login);
    };
    return {
      fetchImpl,
      get calls() {
        return calls;
      }
    };
  }

  it("returns the correct user per token instead of a stale cached one", async () => {
    const f = tokenAwareFetch({ "tok-alice": "alice", "tok-bob": "bob" });
    const a = await getGithubUserSummary("tok-alice", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} });
    expect(a.login).toBe("alice");
    // Second token, different account — must NOT return alice from a token-blind cache.
    const b = await getGithubUserSummary("tok-bob", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} });
    expect(b.login).toBe("bob");
    expect(f.calls).toBe(2);
  });

  it("still caches per token: the same token does not re-fetch within the TTL", async () => {
    const f = tokenAwareFetch({ "tok-alice": "alice" });
    const first = await getGithubUserSummary("tok-alice", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} });
    const second = await getGithubUserSummary("tok-alice", { fetchImpl: f.fetchImpl, sleepImpl: async () => {} });
    expect(first.login).toBe("alice");
    expect(second.login).toBe("alice");
    expect(f.calls).toBe(1); // served from cache the second time
  });
});
