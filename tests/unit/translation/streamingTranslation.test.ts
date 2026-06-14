import { describe, expect, it } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { translateOpenAIStreamToAnthropic } from "../../../src/translation/streamingOpenAIToAnthropic.js";

interface SseEvent {
  event: string;
  data: unknown;
}

async function runTranslator(chunks: readonly string[], fallbackModel?: string): Promise<SseEvent[]> {
  const upstream = Readable.from(chunks, { objectMode: false });
  const downstream = new PassThrough();
  const collected: string[] = [];
  downstream.on("data", (chunk) => {
    collected.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const done = new Promise<void>((resolve) => downstream.on("end", () => resolve()));
  await translateOpenAIStreamToAnthropic({ upstream, downstream, fallbackModel });
  await done;
  return parseSse(collected.join(""));
}

async function runTranslatorRaw(upstream: Readable, fallbackModel?: string): Promise<SseEvent[]> {
  const downstream = new PassThrough();
  const collected: string[] = [];
  downstream.on("data", (chunk) => {
    collected.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const done = new Promise<void>((resolve) => downstream.on("end", () => resolve()));
  await translateOpenAIStreamToAnthropic({ upstream, downstream, fallbackModel });
  await done;
  return parseSse(collected.join(""));
}

function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split("\n\n")) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    let event = "";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
    events.push({ event, data: data.length > 0 ? JSON.parse(data) : null });
  }
  return events;
}

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("streamingOpenAIToAnthropic", () => {
  it("translates a simple text stream into the canonical Anthropic event sequence", async () => {
    const events = await runTranslator([
      dataLine({
        id: "chatcmpl-abc",
        model: "claude-opus-4.7",
        choices: [{ index: 0, delta: { role: "assistant", content: "" } }]
      }),
      dataLine({
        id: "chatcmpl-abc",
        choices: [{ index: 0, delta: { content: "Hello" } }]
      }),
      dataLine({
        id: "chatcmpl-abc",
        choices: [{ index: 0, delta: { content: " world" } }]
      }),
      dataLine({
        id: "chatcmpl-abc",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      }),
      "data: [DONE]\n\n"
    ], "claude-opus-4.7");

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);

    const messageStart = events[0].data as { message: { id: string; model: string; role: string } };
    expect(messageStart.message.role).toBe("assistant");
    expect(messageStart.message.model).toBe("claude-opus-4.7");
    expect(messageStart.message.id.startsWith("msg_")).toBe(true);

    const firstDelta = events[2].data as { delta: { type: string; text: string }; index: number };
    expect(firstDelta).toMatchObject({ index: 0, delta: { type: "text_delta", text: "Hello" } });

    const messageDelta = events[5].data as {
      delta: { stop_reason: string };
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(messageDelta.delta.stop_reason).toBe("end_turn");
    expect(messageDelta.usage.input_tokens).toBe(10);
    expect(messageDelta.usage.output_tokens).toBe(2);
  });

  it("maps finish_reason length to max_tokens", async () => {
    const events = await runTranslator([
      dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { content: "x" } }] }),
      dataLine({ id: "abc", choices: [{ index: 0, finish_reason: "length", delta: {} }] }),
      "data: [DONE]\n\n"
    ]);
    const delta = events.find((e) => e.event === "message_delta")!.data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe("max_tokens");
  });

  it("translates streaming tool_calls into tool_use content blocks with input_json_delta", async () => {
    const events = await runTranslator([
      dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] }),
      dataLine({
        id: "abc",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }
              ]
            }
          }
        ]
      }),
      dataLine({
        id: "abc",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "{\"q\":" } }]
            }
          }
        ]
      }),
      dataLine({
        id: "abc",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "\"hi\"}" } }]
            }
          }
        ]
      }),
      dataLine({
        id: "abc",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      }),
      "data: [DONE]\n\n"
    ]);

    const eventNames = events.map((e) => e.event);
    expect(eventNames).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);

    const blockStart = events[1].data as {
      content_block: { type: string; id: string; name: string };
      index: number;
    };
    expect(blockStart.content_block).toMatchObject({ type: "tool_use", id: "call_1", name: "lookup" });
    expect(blockStart.index).toBe(0);

    const argDelta1 = events[2].data as { delta: { type: string; partial_json: string }; index: number };
    expect(argDelta1).toMatchObject({ index: 0, delta: { type: "input_json_delta", partial_json: "{\"q\":" } });

    const messageDelta = events[5].data as { delta: { stop_reason: string } };
    expect(messageDelta.delta.stop_reason).toBe("tool_use");
  });

  it("closes any open text block when a tool_call appears after text", async () => {
    const events = await runTranslator([
      dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { content: "thinking..." } }] }),
      dataLine({
        id: "abc",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }]
            }
          }
        ]
      }),
      dataLine({ id: "abc", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n"
    ]);

    const sequence = events.map((e) => e.event);
    expect(sequence).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    const firstBlock = events[1].data as { content_block: { type: string }; index: number };
    expect(firstBlock.content_block.type).toBe("text");
    expect(firstBlock.index).toBe(0);
    const secondBlock = events[4].data as { content_block: { type: string }; index: number };
    expect(secondBlock.content_block.type).toBe("tool_use");
    expect(secondBlock.index).toBe(1);
  });

  it("handles cached input tokens in usage", async () => {
    const events = await runTranslator([
      dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { content: "hi" } }] }),
      dataLine({
        id: "abc",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } }
      }),
      "data: [DONE]\n\n"
    ]);
    const messageDelta = events.find((e) => e.event === "message_delta")!.data as {
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
    };
    expect(messageDelta.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 80
    });
  });

  it("emits message_stop even when no chunks contain content", async () => {
    const events = await runTranslator(["data: [DONE]\n\n"]);
    expect(events.map((e) => e.event)).toEqual(["message_start", "message_delta", "message_stop"]);
  });

  it("handles SSE chunks split across input boundaries", async () => {
    const payload = JSON.stringify({
      id: "abc",
      model: "m",
      choices: [{ index: 0, delta: { content: "split" } }]
    });
    const half = Math.floor(payload.length / 2);
    const events = await runTranslator([
      `data: ${payload.slice(0, half)}`,
      `${payload.slice(half)}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const deltaEvent = events.find((e) => e.event === "content_block_delta")!.data as {
      delta: { text: string };
    };
    expect(deltaEvent.delta.text).toBe("split");
  });

  it("stops pinging and resolves cleanly when downstream is destroyed mid-stream", async () => {
    // Regression for the daemon-crash scenario: the ping interval used to fire
    // forever after the client disconnected, throwing ERR_STREAM_DESTROYED
    // from inside a timer callback (uncaughtException → process exit).
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    downstream.on("data", () => {
      /* drain */
    });
    const done = translateOpenAIStreamToAnthropic({
      upstream,
      downstream,
      fallbackModel: "claude-test"
    });

    // Feed one chunk so we get past message_start.
    upstream.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-disconnect",
        model: "claude-test",
        choices: [{ index: 0, delta: { role: "assistant", content: "" } }]
      })}\n\n`
    );

    // Wait for the chunk to be processed.
    await new Promise((r) => setTimeout(r, 30));

    // Capture writes after destroy to prove the translator stops writing.
    const writesAfterDestroy: unknown[] = [];
    const originalWrite = downstream.write.bind(downstream);
    (downstream as { write: unknown }).write = (chunk: unknown) => {
      writesAfterDestroy.push(chunk);
      return originalWrite(chunk as never);
    };

    // Now destroy the downstream — simulates the client socket closing.
    downstream.destroy();

    // Let several ping intervals elapse (PING_INTERVAL_MS = 1000).
    await new Promise((r) => setTimeout(r, 1200));

    // Close the upstream so the translator's loop terminates.
    upstream.end();

    // The translator's promise must resolve, NOT reject, on disconnect.
    await expect(done).resolves.toBeUndefined();

    // And no pings should have leaked through after destroy.
    const pingsAfter = writesAfterDestroy.filter(
      (w) => typeof w === "string" && w.includes("event: ping")
    );
    expect(pingsAfter.length).toBe(0);
  });

  it("survives downstream.write throwing ERR_STREAM_DESTROYED synchronously", async () => {
    // The translator must swallow benign socket errors thrown synchronously
    // from downstream.write — they're a normal symptom of mid-flush close.
    const upstream = Readable.from([
      `data: ${JSON.stringify({
        id: "chatcmpl-err",
        model: "claude-test",
        choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }]
      })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const downstream = new PassThrough();
    let throwCount = 0;
    (downstream as { write: unknown }).write = () => {
      throwCount += 1;
      const err = new Error("ERR_STREAM_DESTROYED") as Error & { code: string };
      err.code = "ERR_STREAM_DESTROYED";
      throw err;
    };

    await expect(
      translateOpenAIStreamToAnthropic({ upstream, downstream, fallbackModel: "claude-test" })
    ).resolves.toBeUndefined();
    expect(throwCount).toBeGreaterThan(0);
  });

  it("does not throw when downstream emits 'close' before upstream completes", async () => {
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    downstream.on("data", () => {
      /* drain */
    });
    const done = translateOpenAIStreamToAnthropic({
      upstream,
      downstream,
      fallbackModel: "claude-test"
    });

    await new Promise((r) => setTimeout(r, 10));
    downstream.emit("close");

    upstream.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-close",
        model: "claude-test",
        choices: [{ index: 0, delta: { content: "after close" } }]
      })}\n\n`
    );
    upstream.end();

    await expect(done).resolves.toBeUndefined();
  });

  it("interleaves text and tool_use, opening a fresh text block after the tool block", async () => {
    const events = await runTranslator([
      dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "before" } }] }),
      dataLine({
        id: "abc",
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "t", arguments: "" } }] } }
        ]
      }),
      dataLine({ id: "abc", choices: [{ index: 0, delta: { content: "after" } }] }),
      dataLine({ id: "abc", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n"
    ]);

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start", // text (index 0)
      "content_block_delta", // "before"
      "content_block_stop", // close text 0 when the tool block opens
      "content_block_start", // tool_use (index 1)
      "content_block_start", // fresh text (index 2)
      "content_block_delta", // "after"
      "content_block_stop", // tool 1
      "content_block_stop", // text 2
      "message_delta",
      "message_stop"
    ]);

    const starts = events.filter((e) => e.event === "content_block_start").map((e) => e.data as { index: number; content_block: { type: string } });
    expect(starts).toMatchObject([
      { index: 0, content_block: { type: "text", text: "" } },
      { index: 1, content_block: { type: "tool_use", id: "call_1", name: "t", input: {} } },
      { index: 2, content_block: { type: "text", text: "" } }
    ]);
  });

  it("translates multiple distinct tool calls into separate tool_use blocks", async () => {
    const events = await runTranslator([
      dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] }),
      dataLine({
        id: "abc",
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "a", arguments: "{}" } }] } }
        ]
      }),
      dataLine({
        id: "abc",
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "b", arguments: "{}" } }] } }
        ]
      }),
      dataLine({ id: "abc", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n"
    ]);

    const toolStarts = events
      .filter((e) => e.event === "content_block_start")
      .map((e) => e.data as { index: number; content_block: { type: string; id?: string; name?: string } })
      .filter((b) => b.content_block.type === "tool_use");
    expect(toolStarts).toMatchObject([
      { index: 0, content_block: { type: "tool_use", id: "call_a", name: "a", input: {} } },
      { index: 1, content_block: { type: "tool_use", id: "call_b", name: "b", input: {} } }
    ]);
  });

  it("emits a recovery sequence (message_delta, error, message_stop) when the upstream errors mid-stream", async () => {
    async function* erroringUpstream(): AsyncGenerator<string> {
      yield dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }] });
      throw new Error("kaboom upstream");
    }

    const events = await runTranslatorRaw(Readable.from(erroringUpstream()), "m");

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "error",
      "message_stop"
    ]);
    const errorEvent = events.find((e) => e.event === "error")!.data as { type: string; error: { type: string } };
    expect(errorEvent).toMatchObject({ type: "error", error: { type: "api_error" } });
  });

  it("ignores comment, event-only, and malformed data lines", async () => {
    const valid = JSON.stringify({ id: "abc", model: "m", choices: [{ index: 0, delta: { content: "ok" } }] });
    const blob =
      [
        ": keepalive comment",
        "event: something",
        "garbage line without a field prefix",
        "data: {broken json",
        "data:   ",
        `data: ${valid}`,
        "data: [DONE]"
      ].join("\n") + "\n\n";

    const events = await runTranslator([blob]);

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    const delta = events.find((e) => e.event === "content_block_delta")!.data as { delta: { text: string } };
    expect(delta.delta.text).toBe("ok");
  });

  it("defaults usage to zero when the upstream omits a usage object", async () => {
    const events = await runTranslator([
      dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { content: "hi" } }] }),
      dataLine({ id: "abc", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n"
    ]);
    const messageDelta = events.find((e) => e.event === "message_delta")!.data as {
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
    };
    expect(messageDelta.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
  });

  it("accepts a partial usage object (prompt_tokens only)", async () => {
    const events = await runTranslator([
      dataLine({ id: "abc", model: "m", choices: [{ index: 0, delta: { content: "hi" } }] }),
      dataLine({ id: "abc", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7 } }),
      "data: [DONE]\n\n"
    ]);
    const messageDelta = events.find((e) => e.event === "message_delta")!.data as {
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(messageDelta.usage.input_tokens).toBe(7);
    expect(messageDelta.usage.output_tokens).toBe(0);
  });

  it("emits a ping while the upstream is idle past the keepalive interval", async () => {
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const collected: string[] = [];
    downstream.on("data", (chunk) => {
      collected.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    const done = translateOpenAIStreamToAnthropic({ upstream, downstream, fallbackModel: "m" });

    upstream.write(
      `data: ${JSON.stringify({ id: "abc", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\n`
    );
    // Stay idle past PING_INTERVAL_MS (1000ms) so the keepalive timer fires.
    await new Promise((r) => setTimeout(r, 1100));
    upstream.end();
    await done;

    expect(collected.join("")).toContain("event: ping");
  });
});
