import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { writeAnthropicSseError } from "../src/server/proxy.js";

// When the proxy has already eagerly emitted the Anthropic `message_start` +
// `ping` prelude and *then* upstream fails (token refresh, 5xx, malformed
// body, etc.), it must wind the stream down with a well-formed Anthropic SSE
// error sequence rather than dumping a JSON object — otherwise Claude Code
// and other Anthropic clients crash mid-stream instead of rendering an error.

interface ResponseCapture {
  writes: string[];
  ended: boolean;
}

function fakeResponse(): { capture: ResponseCapture; res: ServerResponse } {
  const capture: ResponseCapture = { writes: [], ended: false };
  const res = {
    write(chunk: string): boolean {
      capture.writes.push(chunk);
      return true;
    },
    end(): void {
      capture.ended = true;
    }
  } as unknown as ServerResponse;
  return { capture, res };
}

function parseSseEvents(stream: string): Array<{ event: string; data: unknown }> {
  return stream
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const eventLine = chunk.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) {
        throw new Error(`Malformed SSE chunk: ${chunk}`);
      }
      const event = eventLine.slice("event:".length).trim();
      const data = JSON.parse(dataLine.slice("data:".length).trim()) as unknown;
      return { event, data };
    });
}

describe("writeAnthropicSseError", () => {
  it("emits the canonical message_delta → error → message_stop sequence", () => {
    const { capture, res } = fakeResponse();
    writeAnthropicSseError(res, { messageId: "msg_test_123" }, "token_refresh_failed");

    const events = parseSseEvents(capture.writes.join(""));
    expect(events.map((e) => e.event)).toEqual(["message_delta", "error", "message_stop"]);
    expect(capture.ended).toBe(true);
  });

  it("emits a well-formed message_delta with end_turn stop_reason and zero usage", () => {
    const { capture, res } = fakeResponse();
    writeAnthropicSseError(res, { messageId: "msg_test_456" }, "upstream_server_error");

    const events = parseSseEvents(capture.writes.join(""));
    const messageDelta = events[0] as { event: string; data: { type: string; delta: { stop_reason: string; stop_sequence: null }; usage: Record<string, number> } };
    expect(messageDelta.event).toBe("message_delta");
    expect(messageDelta.data.type).toBe("message_delta");
    expect(messageDelta.data.delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
    expect(messageDelta.data.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
  });

  it("emits a well-formed error event carrying the supplied code", () => {
    const { capture, res } = fakeResponse();
    writeAnthropicSseError(res, { messageId: "msg_test_789" }, "upstream_rate_limited");

    const events = parseSseEvents(capture.writes.join(""));
    const errorEvent = events[1] as { event: string; data: { type: string; error: { type: string; message: string } } };
    expect(errorEvent.event).toBe("error");
    expect(errorEvent.data.type).toBe("error");
    expect(errorEvent.data.error.type).toBe("api_error");
    expect(errorEvent.data.error.message).toBe("upstream_rate_limited");
  });

  it("terminates with message_stop carrying type=message_stop and closes the response", () => {
    const { capture, res } = fakeResponse();
    writeAnthropicSseError(res, { messageId: "msg_test_abc" }, "internal_error");

    const events = parseSseEvents(capture.writes.join(""));
    expect(events[2]).toEqual({ event: "message_stop", data: { type: "message_stop" } });
    expect(capture.ended).toBe(true);
  });

  it("still ends the response when an intermediate res.write throws", () => {
    // Defense-in-depth: the finally clause must close the socket even if a
    // write fails partway through, otherwise a wedged client connection leaks.
    const writes: string[] = [];
    let ended = false;
    let callCount = 0;
    const res = {
      write(chunk: string): boolean {
        callCount += 1;
        if (callCount === 2) {
          throw new Error("simulated socket failure");
        }
        writes.push(chunk);
        return true;
      },
      end(): void {
        ended = true;
      }
    } as unknown as ServerResponse;

    expect(() => writeAnthropicSseError(res, { messageId: "msg_x" }, "boom")).toThrow();
    expect(ended).toBe(true);
  });
});
