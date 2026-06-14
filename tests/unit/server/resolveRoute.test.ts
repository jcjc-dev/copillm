import { describe, expect, it } from "vitest";
import { resolveRoute } from "../../../src/server/routes/shared.js";

/**
 * PR D — account-prefix-aware routing. `resolveRoute` peels an optional leading
 * `/<account>` segment for the agent-facing proxy + per-account model routes,
 * while leaving unprefixed and daemon-global routes exactly as before.
 */
describe("resolveRoute — unprefixed (default account)", () => {
  it("matches the existing routes with accountId null", () => {
    expect(resolveRoute("GET", "/livez")).toEqual({ kind: "livez", anthroShape: false, accountId: null });
    expect(resolveRoute("GET", "/healthz")).toEqual({ kind: "healthz", anthroShape: false, accountId: null });
    expect(resolveRoute("GET", "/models")).toEqual({ kind: "models", anthroShape: false, accountId: null });
    expect(resolveRoute("GET", "/v1/models")).toEqual({ kind: "models", anthroShape: false, accountId: null });
    expect(resolveRoute("GET", "/codex/v1/models")).toEqual({ kind: "codex_models", anthroShape: false, accountId: null });
    expect(resolveRoute("GET", "/anthropic/v1/models")).toEqual({ kind: "anthropic_models", anthroShape: false, accountId: null });
    expect(resolveRoute("POST", "/codex/v1/responses")).toEqual({ kind: "codex_responses", anthroShape: false, accountId: null });
    expect(resolveRoute("POST", "/v1/chat/completions")).toEqual({ kind: "openai", anthroShape: false, accountId: null });
    expect(resolveRoute("POST", "/anthropic/v1/messages")).toEqual({ kind: "anthropic", anthroShape: true, accountId: null });
    expect(resolveRoute("POST", "/v1/messages")).toEqual({ kind: "anthropic", anthroShape: true, accountId: null });
    expect(resolveRoute("GET", "/_debug")).toEqual({ kind: "debug", anthroShape: false, accountId: null });
  });
});

describe("resolveRoute — account-prefixed", () => {
  it("peels a leading /<account> for prefixable routes", () => {
    expect(resolveRoute("POST", "/work/codex/v1/responses")).toEqual({
      kind: "codex_responses",
      anthroShape: false,
      accountId: "work"
    });
    expect(resolveRoute("POST", "/work/anthropic/v1/messages")).toEqual({
      kind: "anthropic",
      anthroShape: true,
      accountId: "work"
    });
    expect(resolveRoute("POST", "/octocat-work/v1/messages")).toEqual({
      kind: "anthropic",
      anthroShape: true,
      accountId: "octocat-work"
    });
    expect(resolveRoute("POST", "/work/v1/chat/completions")).toEqual({
      kind: "openai",
      anthroShape: false,
      accountId: "work"
    });
    expect(resolveRoute("GET", "/work/codex/v1/models")).toEqual({
      kind: "codex_models",
      anthroShape: false,
      accountId: "work"
    });
    expect(resolveRoute("GET", "/work/anthropic/v1/models")).toEqual({
      kind: "anthropic_models",
      anthroShape: false,
      accountId: "work"
    });
  });

  it("does not allow prefixing the daemon-global routes", () => {
    expect(resolveRoute("GET", "/work/livez").kind).toBe("not_found");
    expect(resolveRoute("GET", "/work/healthz").kind).toBe("not_found");
    expect(resolveRoute("GET", "/work/models").kind).toBe("not_found");
    expect(resolveRoute("GET", "/work/_debug").kind).toBe("not_found");
  });

  it("never treats a reserved first segment as an account", () => {
    // These are real routes and must always be matched directly.
    expect(resolveRoute("GET", "/codex/v1/models").accountId).toBeNull();
    expect(resolveRoute("POST", "/anthropic/v1/messages").accountId).toBeNull();
    // A reserved word as a contrived prefix is rejected, not treated as an account.
    expect(resolveRoute("POST", "/codex/codex/v1/responses").kind).toBe("not_found");
    expect(resolveRoute("POST", "/v1/v1/chat/completions").kind).toBe("not_found");
  });

  it("rejects path-unsafe account segments", () => {
    expect(resolveRoute("POST", "/..%2f/codex/v1/responses").kind).toBe("not_found");
    expect(resolveRoute("POST", "/has space/v1/messages").kind).toBe("not_found");
  });

  it("returns not_found for an unknown sub-route under a valid account", () => {
    expect(resolveRoute("GET", "/work/nonsense").kind).toBe("not_found");
    expect(resolveRoute("POST", "/work/livez").kind).toBe("not_found");
  });
});
