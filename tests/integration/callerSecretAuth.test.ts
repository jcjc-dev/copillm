import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startStubProxyHarness, type StubProxyHarness } from "../helpers/stubProxyHarness.js";

/**
 * The caller-secret gate (`config.requireCallerSecret`) is an access control on
 * the proxy that had no test coverage — every other test runs with it disabled.
 * When enabled, every route except the unauthenticated liveness probes must
 * carry `Authorization: Bearer <callerSecret>` or get a 401. These tests pin
 * that contract end-to-end through the real `startProxyServer`.
 */

let harness: StubProxyHarness | null = null;

beforeEach(async () => {
  harness = await startStubProxyHarness({ requireCallerSecret: true });
});

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

function chatRequest(authorization?: string): Promise<Response> {
  if (!harness) throw new Error("harness not started");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization) headers.Authorization = authorization;
  return fetch(`${harness.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] })
  });
}

describe("caller-secret gate: liveness probes bypass the secret", () => {
  it("serves /livez without a caller secret", async () => {
    if (!harness) throw new Error("harness not started");
    const response = await fetch(`${harness.baseUrl}/livez`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { status?: string }).toMatchObject({ status: "ok" });
  });

  it("serves /healthz without a caller secret", async () => {
    if (!harness) throw new Error("harness not started");
    const response = await fetch(`${harness.baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { status?: string }).toMatchObject({ status: "ok" });
  });
});

describe("caller-secret gate: protected routes require the secret", () => {
  it("rejects a request with no Authorization header (401)", async () => {
    const response = await chatRequest();
    expect(response.status).toBe(401);
    expect((await response.json()) as { error?: string }).toMatchObject({ error: "invalid_caller_secret" });
  });

  it("rejects a request bearing the wrong secret (401)", async () => {
    const response = await chatRequest("Bearer not-the-secret");
    expect(response.status).toBe(401);
    expect((await response.json()) as { error?: string }).toMatchObject({ error: "invalid_caller_secret" });
  });

  it("rejects a request whose scheme is not Bearer (401)", async () => {
    const response = await chatRequest(`token ${harness?.callerSecret}`);
    expect(response.status).toBe(401);
  });

  it("lets a request bearing the correct secret through to upstream", async () => {
    if (!harness) throw new Error("harness not started");
    harness.setHandlers({
      onChatCompletions: (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: "chatcmpl-secret-ok",
            object: "chat.completion",
            model: "gpt-test",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }]
          })
        );
      }
    });

    const response = await chatRequest(`Bearer ${harness.callerSecret}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id?: string };
    expect(body.id).toBe("chatcmpl-secret-ok");
  });
});
