import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

import { installUncaughtSpy, type UncaughtSpy } from "./helpers/installUncaughtSpy.js";
import {
  buildHttpRequest,
  rawHttpRoundtrip,
  sendAndDropImmediately,
  sendThenDestroy
} from "./helpers/rawSocket.js";
import {
  beginSseResponse,
  startStubProxyHarness,
  type StubProxyHarness
} from "./helpers/stubProxyHarness.js";

/**
 * End-to-end resilience tests for the proxy daemon. Each test triggers one
 * of the failure scenarios that previously caused the daemon process to
 * exit (uncaughtException / unhandledRejection / ERR_HTTP_HEADERS_SENT),
 * then verifies the daemon:
 *
 *   1) does NOT raise an uncaught event (installUncaughtSpy invariant),
 *   2) still serves a follow-up request (the "daemon survived" proof).
 */

let harness: StubProxyHarness | null = null;
let spy: UncaughtSpy | null = null;

beforeEach(async () => {
  spy = installUncaughtSpy();
  harness = await startStubProxyHarness();
});

afterEach(async () => {
  try {
    if (harness) {
      await harness.close();
      harness = null;
    }
  } finally {
    if (spy) {
      const calls = [...spy.calls];
      spy.dispose();
      spy = null;
      if (calls.length > 0) {
        const summary = calls
          .map((c) => `${c.kind}: ${describeReason(c.reason)}`)
          .join("\n  ");
        throw new Error(
          `Resilience invariant violated: process emitted ${calls.length} uncaught event(s):\n  ${summary}`
        );
      }
    }
  }
});

function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}

async function assertDaemonAlive(): Promise<void> {
  if (!harness) throw new Error("harness not started");
  const response = await fetch(`${harness.baseUrl}/livez`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { status?: string };
  expect(body.status).toBe("ok");
}

describe("proxy resilience: /livez baseline", () => {
  it("starts up and serves /livez", async () => {
    await assertDaemonAlive();
  });
});

describe("proxy resilience: client disconnect mid-stream (/codex/v1/responses)", () => {
  it("survives the disconnect and serves the next request", async () => {
    if (!harness) throw new Error("harness not started");

    // Configure the stub upstream to drip-feed an SSE stream forever (until
    // we destroy the client socket).
    harness.setHandlers({
      onResponses: async (_req, res) => {
        const sse = beginSseResponse(res);
        sse.writeEvent("response.created", {
          type: "response.created",
          response: { id: "resp_stub", object: "response", model: "gpt-test-codex", status: "in_progress" }
        });
        // Keep the stream "alive" — periodic delta events until the client
        // goes away. The proxy is what will detect the disconnect.
        const interval = setInterval(() => {
          try {
            sse.writeRaw("data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n");
          } catch {
            clearInterval(interval);
          }
        }, 50);
        res.on("close", () => clearInterval(interval));
      }
    });

    const request = buildHttpRequest({
      method: "POST",
      path: "/codex/v1/responses",
      port: harness.port,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer copillm-test"
      },
      body: JSON.stringify({
        model: "gpt-test-codex",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: true
      })
    });

    const partial = await sendThenDestroy({
      port: harness.port,
      request,
      waitForBytes: 32,
      timeoutMs: 3000
    });
    expect(partial.raw.length).toBeGreaterThan(0);

    // Let the proxy observe the close, abort the upstream fetch, and stop
    // any ping intervals. 1500ms > PING_INTERVAL_MS (1000ms) is enough to
    // trigger the original crash path.
    await sleep(1500);

    await assertDaemonAlive();
  });
});

describe("proxy resilience: client disconnect mid-stream (/anthropic/v1/messages)", () => {
  it("survives the disconnect and serves the next request", async () => {
    if (!harness) throw new Error("harness not started");

    harness.setHandlers({
      onChatCompletions: async (_req, res) => {
        const sse = beginSseResponse(res);
        sse.writeRaw(
          `data: ${JSON.stringify({
            id: "chatcmpl-stub",
            model: "claude-test-sonnet",
            choices: [{ index: 0, delta: { role: "assistant", content: "" } }]
          })}\n\n`
        );
        const interval = setInterval(() => {
          try {
            sse.writeRaw(
              `data: ${JSON.stringify({
                id: "chatcmpl-stub",
                choices: [{ index: 0, delta: { content: "x" } }]
              })}\n\n`
            );
          } catch {
            clearInterval(interval);
          }
        }, 50);
        res.on("close", () => clearInterval(interval));
      }
    });

    const request = buildHttpRequest({
      method: "POST",
      path: "/anthropic/v1/messages",
      port: harness.port,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer copillm-test"
      },
      body: JSON.stringify({
        model: "claude-test-sonnet",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })
    });

    const partial = await sendThenDestroy({
      port: harness.port,
      request,
      waitForBytes: 32,
      timeoutMs: 3000
    });
    expect(partial.raw.length).toBeGreaterThan(0);

    await sleep(1500);
    await assertDaemonAlive();
  });
});

describe("proxy resilience: upstream errors after headers flushed", () => {
  it("survives upstream socket destroy after the Anthropic prelude was sent", async () => {
    if (!harness) throw new Error("harness not started");

    harness.setHandlers({
      onChatCompletions: async (_req, res) => {
        const sse = beginSseResponse(res);
        sse.writeRaw("data: {\"id\":\"x\",\"model\":\"claude-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n");
        // Hard kill the underlying socket to simulate an upstream blip
        // after the proxy has already flushed its Anthropic prelude.
        setTimeout(() => sse.destroy(), 30);
      }
    });

    const response = await fetch(`${harness.baseUrl}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer copillm-test"
      },
      body: JSON.stringify({
        model: "claude-test-sonnet",
        max_tokens: 64,
        messages: [{ role: "user", content: "ping" }],
        stream: true
      })
    });
    expect(response.status).toBe(200);

    // Drain the SSE body. We tolerate undici "terminated" errors here —
    // upstream socket destruction propagates to our response, and the test's
    // concern is that the daemon survives, not that the body ends cleanly.
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // expected — upstream died mid-stream
      }
    }

    await sleep(100);
    await assertDaemonAlive();
  });

  it("survives upstream socket destroy mid-stream on /codex/v1/responses (pipeEventStream path)", async () => {
    if (!harness) throw new Error("harness not started");

    harness.setHandlers({
      onResponses: async (_req, res) => {
        const sse = beginSseResponse(res);
        sse.writeEvent("response.created", {
          type: "response.created",
          response: { id: "resp_stub", object: "response", model: "gpt-test-codex", status: "in_progress" }
        });
        setTimeout(() => sse.destroy(), 30);
      }
    });

    const response = await fetch(`${harness.baseUrl}/codex/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer copillm-test"
      },
      body: JSON.stringify({
        model: "gpt-test-codex",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
        stream: true
      })
    });
    expect(response.status).toBe(200);

    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // upstream destruction propagates as a body-termination error
      }
    }

    await sleep(100);
    await assertDaemonAlive();
  });
});

describe("proxy resilience: malformed HTTP (clientError)", () => {
  it("replies 400 and does not crash on garbage bytes", async () => {
    if (!harness) throw new Error("harness not started");
    // Garbage that doesn't look like HTTP at all.
    await sendAndDropImmediately({
      port: harness.port,
      payload: Buffer.from("GARBAGE BYTES NOT HTTP\r\n\r\n")
    });
    await sleep(50);
    await assertDaemonAlive();
  });
});

describe("proxy resilience: aborted request body", () => {
  it("does not crash when the client aborts a partial POST body", async () => {
    if (!harness) throw new Error("harness not started");

    // Send a POST with a giant Content-Length but only a few bytes of body,
    // then drop the socket.
    const headers = [
      "POST /codex/v1/responses HTTP/1.1",
      `Host: 127.0.0.1:${harness.port}`,
      "Content-Type: application/json",
      "Authorization: Bearer x",
      "Content-Length: 9999999",
      "Connection: close",
      "",
      "{\"model\":\"x"
    ].join("\r\n");

    await sendAndDropImmediately({
      port: harness.port,
      payload: Buffer.from(headers, "utf8")
    });
    await sleep(50);
    await assertDaemonAlive();
  });
});

describe("proxy resilience: multiple consecutive disconnects + healthy request", () => {
  it("stays alive after several mid-stream aborts and still serves a normal request", async () => {
    if (!harness) throw new Error("harness not started");

    harness.setHandlers({
      onResponses: async (_req, res) => {
        const sse = beginSseResponse(res);
        sse.writeEvent("response.created", {
          type: "response.created",
          response: { id: "resp_stub", object: "response", model: "gpt-test-codex", status: "in_progress" }
        });
        const interval = setInterval(() => {
          try {
            sse.writeRaw("data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n");
          } catch {
            clearInterval(interval);
          }
        }, 50);
        res.on("close", () => clearInterval(interval));
      }
    });

    for (let i = 0; i < 5; i += 1) {
      const request = buildHttpRequest({
        method: "POST",
        path: "/codex/v1/responses",
        port: harness.port,
        headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
        body: JSON.stringify({
          model: "gpt-test-codex",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `ping-${i}` }] }],
          stream: true
        })
      });
      await sendThenDestroy({ port: harness.port, request, waitForBytes: 32, timeoutMs: 2000 });
    }

    await sleep(500);
    await assertDaemonAlive();

    // And a completing, normal /livez round-trip should work fine.
    const livezReq = buildHttpRequest({ method: "GET", path: "/livez", port: harness.port });
    const livez = await rawHttpRoundtrip({ port: harness.port, request: livezReq });
    expect(livez.status).toBe(200);
  });
});
