import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";

import { CopilotTokenManager } from "../../src/auth/copilotToken.js";
import { startProxyServer } from "../../src/server/proxy.js";
import type { AccountResolver, ResolvedAccount } from "../../src/server/accountResolver.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Concurrency coverage: one daemon serves multiple agents at once, but every
 * existing test drives it serially. These tests fire many overlapping requests
 * and assert (a) each response is matched to its own request (no cross-talk or
 * interleaving), (b) per-account requests carry the right bearer under
 * concurrent traffic, and (c) a slow request doesn't stall its siblings.
 */

const SAVED_ENV: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in SAVED_ENV)) {
    SAVED_ENV[name] = process.env[name];
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
function restoreEnv(): void {
  for (const [name, original] of Object.entries(SAVED_ENV)) {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
    delete SAVED_ENV[name];
  }
}

function preloadBearer(manager: CopilotTokenManager, bearer: string): void {
  (manager as unknown as { state: { token: string; expiresAtUnix: number } }).state = {
    token: bearer,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  return (server.address() as AddressInfo).port;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function markerOf(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ content?: unknown }> | undefined;
  const first = messages?.[0]?.content;
  return typeof first === "string" ? first : "";
}

function extractOpenAIStreamText(raw: string): string {
  let text = "";
  for (const block of raw.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch {
      /* ignore */
    }
  }
  return text;
}

let upstream: Server;
let proxy: { close: () => Promise<void> };
let proxyPort: number;
let inFlight = 0;
let maxInFlight = 0;

beforeEach(async () => {
  inFlight = 0;
  maxInFlight = 0;
  upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/chat/completions" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      const body = await readBody(req);
      const marker = markerOf(body);
      const bearer = req.headers.authorization ?? "";
      // Small delay so concurrent requests genuinely overlap in flight; a longer
      // delay for "slow" markers lets the stall-resistance test mean something.
      await sleep(marker.includes("slow") ? 600 : 25);
      if (body.stream === true) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`);
        for (const ch of `echo:${marker}`) {
          res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: ch } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-x",
          object: "chat.completion",
          model: "gpt-test",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `echo:${marker}` } }],
          _marker: marker,
          _bearer: bearer
        })
      );
    } finally {
      inFlight -= 1;
    }
  });
  const upstreamPort = await listen(upstream);
  setEnv("COPILLM_UPSTREAM_BASE_URL", `http://127.0.0.1:${upstreamPort}`);
  setEnv("COPILLM_TOKEN_EXCHANGE_URL", `http://127.0.0.1:${upstreamPort}/__token`);

  const defaultManager = new CopilotTokenManager("ght-default");
  preloadBearer(defaultManager, "bearer-default");
  const workManager = new CopilotTokenManager("ght-work");
  preloadBearer(workManager, "bearer-work");

  const defaultAccount: ResolvedAccount = {
    accountId: null,
    githubToken: "ght-default",
    tokenManager: defaultManager,
    accountType: "individual",
    cacheId: undefined
  };
  const workAccount: ResolvedAccount = {
    accountId: "work",
    githubToken: "ght-work",
    tokenManager: workManager,
    accountType: "business",
    cacheId: "work"
  };
  const resolver: AccountResolver = {
    default: defaultAccount,
    async resolveById(accountId: string) {
      return accountId === "work" ? workAccount : null;
    },
    describe() {
      return { defaultAccountId: null, activeAccountIds: ["work"] };
    },
    clearAll() {
      /* no-op */
    }
  };

  const config: AppConfig = {
    preferredPort: 0,
    requireCallerSecret: false,
    selectedModels: [],
    accountType: "individual"
  };
  proxyPort = await freePort();
  proxy = await startProxyServer({
    port: proxyPort,
    config,
    logger: pino({ level: "silent" }),
    tokenManager: defaultManager,
    githubToken: "ght-default",
    accountResolver: resolver,
    callerSecret: null
  });
});

afterEach(async () => {
  await proxy.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  restoreEnv();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function post(path: string, marker: string, stream: boolean): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-test" },
    body: JSON.stringify({ model: "gpt-test", stream, messages: [{ role: "user", content: marker }] })
  });
}

describe("proxy concurrency", () => {
  it("matches each concurrent response to its own request (mixed streaming + non-streaming)", async () => {
    const count = 30;
    const markers = Array.from({ length: count }, (_, i) => `tok${i}`);

    const results = await Promise.all(
      markers.map(async (marker, i) => {
        const streaming = i % 2 === 1;
        const response = await post("/v1/chat/completions", marker, streaming);
        expect(response.status).toBe(200);
        if (streaming) {
          return extractOpenAIStreamText(await response.text());
        }
        const json = (await response.json()) as { choices: Array<{ message: { content: string } }>; _marker: string };
        expect(json._marker).toBe(marker);
        return json.choices[0].message.content;
      })
    );

    results.forEach((content, i) => {
      expect(content).toBe(`echo:${markers[i]}`);
    });
    // Genuine overlap, not serial processing.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("routes concurrent per-account requests to the correct bearer with no cross-talk", async () => {
    const count = 24;
    const requests = Array.from({ length: count }, (_, i) => ({
      account: i % 2 === 0 ? "default" : "work",
      marker: `acct${i}`
    }));

    const results = await Promise.all(
      requests.map(async ({ account, marker }) => {
        const path = account === "work" ? "/work/v1/chat/completions" : "/v1/chat/completions";
        const response = await post(path, marker, false);
        expect(response.status).toBe(200);
        const json = (await response.json()) as { _marker: string; _bearer: string };
        return { account, marker, json };
      })
    );

    for (const { account, marker, json } of results) {
      expect(json._marker).toBe(marker);
      expect(json._bearer).toBe(account === "work" ? "Bearer bearer-work" : "Bearer bearer-default");
    }
  });

  it("serves fast requests without waiting on a slow concurrent request", async () => {
    const slow = post("/v1/chat/completions", "slow-request", false);
    const fastMarkers = Array.from({ length: 10 }, (_, i) => `fast${i}`);

    const fastStart = Date.now();
    const fastResults = await Promise.all(
      fastMarkers.map(async (marker) => {
        const response = await post("/v1/chat/completions", marker, false);
        const json = (await response.json()) as { _marker: string };
        return json._marker;
      })
    );
    const fastElapsed = Date.now() - fastStart;

    expect([...fastResults].sort()).toEqual([...fastMarkers].sort());
    // Fast requests resolve well before the slow one's 600ms upstream delay —
    // proof they weren't serialized behind it. The generous threshold keeps the
    // assertion robust on slow CI runners while still failing if serialized.
    expect(fastElapsed).toBeLessThan(400);

    const slowJson = (await slow).json() as Promise<{ _marker: string }>;
    expect((await slowJson)._marker).toBe("slow-request");
  });
});
