import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startStubProxyHarness, type StubProxyHarness } from "../helpers/stubProxyHarness.js";

/**
 * Regression for the lossy error rewrap in `src/server/routes/proxyForward.ts`.
 *
 * Before the fix, any `ProtocolTranslationError` thrown from the Anthropic →
 * OpenAI translator was caught and re-thrown as `InvalidRequestShapeError`,
 * which made the proxy surface the generic 400
 * `{ error: "invalid_request_shape", detail: "<original message>" }`.
 *
 * The original ProtocolTranslationError carries a structured `code` field
 * (`invalid_tool_result`, `invalid_text_block`, `unsupported_block`, …) that
 * is meaningful to clients trying to diagnose what they sent. Today the
 * proxy preserves that code by letting `ProtocolTranslationError` propagate
 * out of `translateRequestBody` and be handled by the matching branch in
 * `src/server/proxy.ts`.
 */

let harness: StubProxyHarness | null = null;

beforeEach(async () => {
  harness = await startStubProxyHarness();
});

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

describe("proxy: Anthropic translator surfaces ProtocolTranslationError codes verbatim", () => {
  it("returns the original error code (not invalid_request_shape) when tool_use_id is missing", async () => {
    if (!harness) throw new Error("harness not started");

    let upstreamHit = false;
    harness.setHandlers({
      onChatCompletions: async (_req, res) => {
        upstreamHit = true;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
      }
    });

    const response = await fetch(`${harness.baseUrl}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-test" },
      body: JSON.stringify({
        model: "claude-test-sonnet",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              // Missing tool_use_id — translator throws ProtocolTranslationError
              // with code "invalid_tool_result". The client should see that code,
              // not the rewrapped "invalid_request_shape".
              { type: "tool_result", content: "result" }
            ]
          }
        ]
      })
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string; detail?: string };
    expect(body.error).toBe("invalid_tool_result");
    expect(body.detail).toMatch(/tool_use_id/);
    expect(upstreamHit).toBe(false);
  });

  it("returns the original error code when a system prompt contains a non-text block", async () => {
    if (!harness) throw new Error("harness not started");

    harness.setHandlers({
      onChatCompletions: async (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
      }
    });

    const response = await fetch(`${harness.baseUrl}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-test" },
      body: JSON.stringify({
        model: "claude-test-sonnet",
        max_tokens: 64,
        system: [
          { type: "text", text: "be concise" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }
        ],
        messages: [{ role: "user", content: "hi" }]
      })
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string; detail?: string };
    expect(body.error).toBe("unsupported_block");
    expect(body.detail).toMatch(/system prompt/);
  });
});
