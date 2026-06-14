import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listModels, listModelsUnion } from "../../../src/models/discovery.js";
import { readModelIdsFromCache } from "../../../src/models/anthropicDefaults.js";

/**
 * PR C — per-account model cache. Different accounts can be entitled to
 * different model sets, so each named account caches into its own
 * `models.cache.<id>.json`, while the primary/legacy account (accountId
 * omitted) keeps the shared `models.cache.json`.
 */

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-modelcache-"));
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
});

function catalog(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function fetchReturning(ids: string[]): typeof fetch {
  return async () => catalog(ids);
}

describe("per-account model cache", () => {
  it("writes a namespaced cache file for a named account and the legacy file for the default", async () => {
    await listModels("individual", "tok", { fetchImpl: fetchReturning(["m-default"]) });
    await listModels("business", "tok", { fetchImpl: fetchReturning(["m-work"]) }, "work");

    expect(fs.existsSync(path.join(tmpHome, "models.cache.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, "models.cache.work.json"))).toBe(true);
  });

  it("keeps each account's cached catalog independent", async () => {
    // Seed two different catalogs into two accounts via a live fetch each.
    await listModels("business", "tok", { fetchImpl: fetchReturning(["a-1", "a-2"]) }, "acct-a");
    await listModels("business", "tok", { fetchImpl: fetchReturning(["b-1"]) }, "acct-b");

    // Now make upstream unreachable so each falls back to its OWN cache.
    const failing: typeof fetch = async () => new Response("nope", { status: 503 });
    const a = await listModels("business", "tok", { fetchImpl: failing }, "acct-a");
    const b = await listModels("business", "tok", { fetchImpl: failing }, "acct-b");

    expect(a.source).toBe("cache");
    expect(a.models.map((m) => m.id).sort()).toEqual(["a-1", "a-2"]);
    expect(b.source).toBe("cache");
    expect(b.models.map((m) => m.id)).toEqual(["b-1"]);
  });

  it("does not let a named account read the legacy default cache", async () => {
    // Populate ONLY the legacy default cache.
    await listModels("individual", "tok", { fetchImpl: fetchReturning(["only-default"]) });

    // A named account with upstream down and no cache of its own must NOT
    // borrow the default's catalog — it should fail to find a snapshot.
    const failing: typeof fetch = async () => new Response("nope", { status: 503 });
    await expect(listModels("business", "tok", { fetchImpl: failing }, "lonely")).rejects.toThrow(
      /no cache snapshot is available/i
    );
  });

  it("listModelsUnion threads the accountId to the per-account cache", async () => {
    await listModelsUnion("business", "tok", 2, { fetchImpl: fetchReturning(["u-1"]) }, "union-acct");
    expect(fs.existsSync(path.join(tmpHome, "models.cache.union-acct.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, "models.cache.json"))).toBe(false);
  });

  it("readModelIdsFromCache reads the scoped cache when given an account id", async () => {
    await listModels("individual", "tok", { fetchImpl: fetchReturning(["d-1"]) });
    await listModels("business", "tok", { fetchImpl: fetchReturning(["w-1", "w-2"]) }, "work");

    expect(readModelIdsFromCache().sort()).toEqual(["d-1"]);
    expect(readModelIdsFromCache("work").sort()).toEqual(["w-1", "w-2"]);
    // An account with no cache returns an empty list rather than throwing.
    expect(readModelIdsFromCache("absent")).toEqual([]);
  });

  it("rejects a path-unsafe account id before constructing a cache filename", async () => {
    await expect(
      listModels("individual", "tok", { fetchImpl: fetchReturning(["x"]) }, "../escape")
    ).rejects.toThrow(/invalid account id/i);
  });
});
