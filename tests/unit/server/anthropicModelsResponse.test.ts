import { describe, expect, it } from "vitest";
import {
  buildAnthropicModelsResponse,
  isAnthropicSurfaceEligible
} from "../../../src/server/anthropicModelsResponse.js";

function model(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "fixture-model",
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
    ...overrides
  };
}

describe("isAnthropicSurfaceEligible", () => {
  it("accepts a model with /chat/completions in supported_endpoints + picker enabled", () => {
    expect(
      isAnthropicSurfaceEligible({
        id: "claude-test-opus",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages", "/chat/completions"],
        policy: { state: "enabled" }
      } as never)
    ).toBe(true);
  });

  it("accepts non-claude models when capability conditions are met (gemini, gpt)", () => {
    expect(
      isAnthropicSurfaceEligible(model({ id: "gemini-test-pro" }) as never)
    ).toBe(true);
    expect(
      isAnthropicSurfaceEligible(model({ id: "gpt-test" }) as never)
    ).toBe(true);
  });

  it("accepts when policy.state is absent (treated as enabled)", () => {
    expect(
      isAnthropicSurfaceEligible(model({ id: "claude-test-haiku", policy: undefined }) as never)
    ).toBe(true);
  });

  it("rejects when model_picker_enabled is false (legacy / hidden models)", () => {
    expect(
      isAnthropicSurfaceEligible(model({ id: "gpt-legacy", model_picker_enabled: false }) as never)
    ).toBe(false);
  });

  it("rejects when policy.state is anything other than 'enabled'", () => {
    expect(
      isAnthropicSurfaceEligible(model({ id: "claude-disabled", policy: { state: "disabled" } }) as never)
    ).toBe(false);
    expect(
      isAnthropicSurfaceEligible(model({ id: "claude-preview", policy: { state: "preview" } }) as never)
    ).toBe(false);
  });

  it("rejects models without /chat/completions in supported_endpoints", () => {
    expect(
      isAnthropicSurfaceEligible(model({ id: "gpt-responses-only", supported_endpoints: ["/responses"] }) as never)
    ).toBe(false);
    expect(
      isAnthropicSurfaceEligible(model({ id: "embed-only", supported_endpoints: ["/embeddings"] }) as never)
    ).toBe(false);
  });

  it("rejects when supported_endpoints is missing or not an array", () => {
    expect(
      isAnthropicSurfaceEligible(model({ id: "no-endpoints", supported_endpoints: undefined }) as never)
    ).toBe(false);
    expect(
      isAnthropicSurfaceEligible(model({ id: "bad-endpoints-shape", supported_endpoints: "everything" }) as never)
    ).toBe(false);
  });

  it("rejects when id is missing or empty", () => {
    expect(
      isAnthropicSurfaceEligible(model({ id: "" }) as never)
    ).toBe(false);
    expect(
      isAnthropicSurfaceEligible({ ...model({}), id: undefined } as never)
    ).toBe(false);
  });
});

describe("buildAnthropicModelsResponse", () => {
  it("includes every capability-eligible model regardless of vendor naming", () => {
    const response = buildAnthropicModelsResponse([
      model({ id: "claude-test-opus", name: "Claude Test Opus" }) as never,
      model({ id: "claude-test-sonnet" }) as never,
      model({ id: "gemini-test-pro", name: "Gemini Test Pro" }) as never,
      model({ id: "gpt-test", name: "GPT Test" }) as never,
      model({ id: "gpt-test-codex", supported_endpoints: ["/responses"] }) as never
    ]);

    expect(response.data.map((entry) => entry.id)).toEqual([
      "claude-test-opus",
      "claude-test-sonnet",
      "gemini-test-pro",
      "gpt-test"
    ]);
    expect(response.has_more).toBe(false);
    expect(response.first_id).toBe("claude-test-opus");
    expect(response.last_id).toBe("gpt-test");
  });

  it("emits the Anthropic spec entry shape (type=model, display_name, created_at)", () => {
    const response = buildAnthropicModelsResponse([
      model({
        id: "claude-test-opus",
        name: "Claude Test Opus",
        created_at: "2024-01-01T00:00:00Z"
      }) as never
    ]);
    expect(response.data[0]).toEqual({
      type: "model",
      id: "claude-test-opus",
      display_name: "Claude Test Opus",
      created_at: "2024-01-01T00:00:00Z"
    });
  });

  it("returns empty data when no models pass the capability gate", () => {
    const response = buildAnthropicModelsResponse([
      model({ id: "gpt-responses-only", supported_endpoints: ["/responses"] }) as never,
      model({ id: "gpt-legacy", model_picker_enabled: false }) as never
    ]);
    expect(response.data).toEqual([]);
    expect(response.first_id).toBeNull();
    expect(response.last_id).toBeNull();
  });

  it("falls back to id when no display_name is present", () => {
    const response = buildAnthropicModelsResponse([
      model({ id: "claude-test-no-name" }) as never
    ]);
    expect(response.data[0].display_name).toBe("claude-test-no-name");
  });

  it("appends [1m] to ids of opus models whose upstream max_context_window_tokens is >= 1_000_000", () => {
    const response = buildAnthropicModelsResponse([
      model({
        id: "claude-test-opus-mega",
        name: "Claude Test Opus Mega",
        capabilities: { limits: { max_context_window_tokens: 1_000_000 } }
      }) as never,
      model({
        id: "claude-test-opus-200k",
        name: "Claude Test Opus 200K",
        capabilities: { limits: { max_context_window_tokens: 200_000 } }
      }) as never,
      model({
        id: "claude-test-opus-unknown",
        name: "Claude Test Opus Unknown"
        // no capabilities.limits at all
      }) as never
    ]);

    expect(response.data.map((entry) => entry.id)).toEqual([
      "claude-test-opus-mega[1m]",
      "claude-test-opus-200k",
      "claude-test-opus-unknown"
    ]);
    // display_name is the user-visible label and stays untouched even when id is aliased.
    expect(response.data[0].display_name).toBe("Claude Test Opus Mega");
    expect(response.first_id).toBe("claude-test-opus-mega[1m]");
  });

  it("does not append [1m] to non-opus models even if they have >=1M context — Claude Code's matcher only fires for opus", () => {
    const response = buildAnthropicModelsResponse([
      model({
        id: "gpt-test-mega",
        name: "GPT Test Mega",
        capabilities: { limits: { max_context_window_tokens: 1_050_000 } }
      }) as never,
      model({
        id: "claude-test-sonnet-mega",
        name: "Claude Test Sonnet Mega",
        capabilities: { limits: { max_context_window_tokens: 1_000_000 } }
      }) as never,
      model({
        id: "gemini-test-mega",
        capabilities: { limits: { max_context_window_tokens: 2_000_000 } }
      }) as never
    ]);
    expect(response.data.map((entry) => entry.id)).toEqual([
      "gpt-test-mega",
      "claude-test-sonnet-mega",
      "gemini-test-mega"
    ]);
  });

  it("does not append [1m] to a model just over Claude Code's 200K cap (999_999) — boundary check", () => {
    const response = buildAnthropicModelsResponse([
      model({
        id: "claude-test-opus-almost-1m",
        capabilities: { limits: { max_context_window_tokens: 999_999 } }
      }) as never
    ]);
    expect(response.data[0].id).toBe("claude-test-opus-almost-1m");
  });

  it("does not double-suffix when the upstream id already ends in [1m]", () => {
    const response = buildAnthropicModelsResponse([
      model({
        id: "claude-test-opus-already[1m]",
        capabilities: { limits: { max_context_window_tokens: 2_000_000 } }
      }) as never
    ]);
    expect(response.data[0].id).toBe("claude-test-opus-already[1m]");
  });

  it("maps a dotted upstream claude version to Claude Code's dashed surface id", () => {
    // Claude Code canonicalises a dotted id (claude-…-4.6) to the deprecated
    // claude-…-4-0; the dashed form is matched correctly. See claudeModelId.ts.
    const response = buildAnthropicModelsResponse([
      model({ id: "claude-test-sonnet-4.6", name: "Claude Test Sonnet 4.6" }) as never,
      model({ id: "claude-test-haiku-4.5" }) as never
    ]);
    expect(response.data.map((entry) => entry.id)).toEqual([
      "claude-test-sonnet-4-6",
      "claude-test-haiku-4-5"
    ]);
    // display_name is the user-visible label and keeps its dotted spelling.
    expect(response.data[0].display_name).toBe("Claude Test Sonnet 4.6");
  });

  it("combines the dashed surface id with the [1m] opus alias", () => {
    const response = buildAnthropicModelsResponse([
      model({
        id: "claude-test-opus-4.8",
        capabilities: { limits: { max_context_window_tokens: 1_000_000 } }
      }) as never
    ]);
    expect(response.data[0].id).toBe("claude-test-opus-4-8[1m]");
  });
});
