import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";

import { startStubProxyHarness, type StubProxyHarness } from "../helpers/stubProxyHarness.js";

/**
 * Wire-level proof that the Anthropic route translates image content blocks
 * into OpenAI `image_url` parts before forwarding upstream. The pure-function
 * translation is unit-tested in tests/unit/translation; this exercises the full
 * `/anthropic/v1/messages` → translate → upstream path through the real proxy.
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function cannedOpenAIReply(): Record<string, unknown> {
  return {
    id: "chatcmpl-image-test",
    object: "chat.completion",
    model: "claude-test-sonnet",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "i see a cat" } }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
  };
}

describe("proxy: Anthropic image translation reaches upstream", () => {
  it("forwards a base64 image block as an OpenAI image_url data URL", async () => {
    if (!harness) throw new Error("harness not started");

    let upstreamBody: Record<string, unknown> | null = null;
    harness.setHandlers({
      onChatCompletions: async (req, res) => {
        upstreamBody = await readJsonBody(req);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(cannedOpenAIReply()));
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
              { type: "text", text: "what is in this image?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }
            ]
          }
        ]
      })
    });

    expect(response.status).toBe(200);

    const messages = (upstreamBody as { messages?: unknown } | null)?.messages as
      | Array<{ role: string; content: unknown }>
      | undefined;
    expect(Array.isArray(messages)).toBe(true);
    const userMessage = messages?.find((m) => m.role === "user");
    expect(userMessage?.content).toEqual([
      { type: "text", text: "what is in this image?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }
    ]);

    // Downstream client still receives a well-formed Anthropic message.
    const body = (await response.json()) as { type?: string; role?: string; content?: unknown };
    expect(body).toMatchObject({ type: "message", role: "assistant" });
  });
});
