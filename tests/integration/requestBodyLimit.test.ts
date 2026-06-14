import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startStubProxyHarness, type StubProxyHarness } from "../helpers/stubProxyHarness.js";

/**
 * Wire-level proof that an oversized request body is rejected with 413
 * `payload_too_large` by the real proxy, before it is buffered or forwarded.
 * The cap is lowered via COPILLM_MAX_REQUEST_BYTES so the test stays small.
 */

let harness: StubProxyHarness | null = null;
const ORIGINAL_MAX = process.env.COPILLM_MAX_REQUEST_BYTES;

beforeEach(async () => {
  process.env.COPILLM_MAX_REQUEST_BYTES = "2000";
  harness = await startStubProxyHarness();
});

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
  if (ORIGINAL_MAX === undefined) {
    delete process.env.COPILLM_MAX_REQUEST_BYTES;
  } else {
    process.env.COPILLM_MAX_REQUEST_BYTES = ORIGINAL_MAX;
  }
});

describe("proxy: request body size limit", () => {
  it("rejects an oversized body with 413 payload_too_large", async () => {
    if (!harness) throw new Error("harness not started");
    const big = "x".repeat(5000);
    const response = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-test" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: big }] })
    });

    expect(response.status).toBe(413);
    expect((await response.json()) as { error?: string }).toMatchObject({ error: "payload_too_large" });
  });

  it("forwards a request under the limit normally", async () => {
    if (!harness) throw new Error("harness not started");
    harness.setHandlers({
      onChatCompletions: (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: "chatcmpl-small-ok",
            object: "chat.completion",
            model: "gpt-test",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }]
          })
        );
      }
    });

    const response = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-test" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] })
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { id?: string }).toMatchObject({ id: "chatcmpl-small-ok" });
  });
});
