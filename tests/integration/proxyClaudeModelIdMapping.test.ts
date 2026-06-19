import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";

import { startStubProxyHarness, type StubProxyHarness } from "../helpers/stubProxyHarness.js";

/**
 * Round-trip for the Claude surface model-id mapping in
 * `src/models/claudeModelId.ts` + `src/server/routes/proxyForward.ts`.
 *
 * copillm advertises Claude models to Claude Code in a dash-separated form
 * (`claude-…-4-6`) so Claude Code does not canonicalise them to the deprecated
 * `claude-…-4-0`. Upstream Copilot only accepts the dotted id (`claude-…-4.6`),
 * so the proxy must rewrite the model back before forwarding and echo the
 * dashed id to the client.
 */

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

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

describe("proxy: Claude surface model-id mapping (dashed <-> dotted)", () => {
  it("forwards the dotted upstream id and echoes the dashed id (non-streaming)", async () => {
    if (!harness) throw new Error("harness not started");

    let upstreamModel: unknown = null;
    harness.setHandlers({
      onChatCompletions: async (req, res) => {
        const body = await readJsonBody(req);
        upstreamModel = body.model;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
      }
    });

    const response = await fetch(`${harness.baseUrl}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-test" },
      body: JSON.stringify({
        model: "claude-test-sonnet-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    const json = (await response.json()) as { model?: string };

    expect(response.status).toBe(200);
    // Upstream Copilot must receive the dotted id it understands.
    expect(upstreamModel).toBe("claude-test-sonnet-4.6");
    // Claude Code must see its own dash-separated id echoed back.
    expect(json.model).toBe("claude-test-sonnet-4-6");
  });

  it("strips the [1m] alias, forwards dotted, and streams back the dashed id", async () => {
    if (!harness) throw new Error("harness not started");

    let upstreamModel: unknown = null;
    harness.setHandlers({
      onChatCompletions: async (req, res) => {
        const body = await readJsonBody(req);
        upstreamModel = body.model;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        const id = "chatcmpl-stream";
        const write = (obj: unknown): void => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };
        write({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        write({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] });
        write({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });

    const response = await fetch(`${harness.baseUrl}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-test" },
      body: JSON.stringify({
        model: "claude-test-opus-4-8[1m]",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    // Upstream gets the dotted id with the [1m] alias removed.
    expect(upstreamModel).toBe("claude-test-opus-4.8");
    // The streamed events carry the dashed surface id, never the dotted one.
    expect(text).toContain("claude-test-opus-4-8");
    expect(text).not.toContain("claude-test-opus-4.8");
  });

  it("leaves non-claude ids untouched on the anthropic surface", async () => {
    if (!harness) throw new Error("harness not started");

    let upstreamModel: unknown = null;
    harness.setHandlers({
      onChatCompletions: async (req, res) => {
        const body = await readJsonBody(req);
        upstreamModel = body.model;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
      }
    });

    const response = await fetch(`${harness.baseUrl}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-test" },
      body: JSON.stringify({
        model: "gpt-test-5.4",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    const json = (await response.json()) as { model?: string };

    expect(response.status).toBe(200);
    expect(upstreamModel).toBe("gpt-test-5.4");
    expect(json.model).toBe("gpt-test-5.4");
  });
});
