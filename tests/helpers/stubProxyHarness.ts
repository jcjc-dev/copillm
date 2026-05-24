import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { AddressInfo } from "node:net";

import pino from "pino";

import { CopilotTokenManager } from "../../src/auth/copilotToken.js";
import { startProxyServer } from "../../src/server/proxy.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Spin up the real `startProxyServer` against a controllable mock upstream,
 * exclusively for resilience tests. This is deliberately distinct from the
 * full mock-backend used by e2e: it lets each test register one-off handlers
 * that can hang, abort mid-stream, send invalid JSON, etc.
 *
 * The harness short-circuits the Copilot token exchange so we never need to
 * stand up a fake `/copilot_internal/v2/token` endpoint.
 */
export interface StubProxyHandlers {
  /** Called for `POST <upstreamBase>/responses` (Codex path). */
  onResponses?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  /** Called for `POST <upstreamBase>/chat/completions` (OpenAI + Anthropic paths). */
  onChatCompletions?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  /** Called for `GET <upstreamBase>/models`. */
  onModels?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface StubProxyHarness {
  port: number;
  baseUrl: string;
  upstreamBaseUrl: string;
  setHandlers: (handlers: StubProxyHandlers) => void;
  close: () => Promise<void>;
}

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

export async function startStubProxyHarness(): Promise<StubProxyHarness> {
  let currentHandlers: StubProxyHandlers = {};
  const upstream = await startStubUpstream({
    handlers: () => currentHandlers
  });

  setEnv("COPILLM_UPSTREAM_BASE_URL", upstream.baseUrl);
  // Point the token exchange at the same stub — it returns a synthetic bearer
  // (the harness preloads the token manager, so this is only used if a
  // refresh fires mid-test).
  setEnv("COPILLM_TOKEN_EXCHANGE_URL", `${upstream.baseUrl}/__token`);

  const logger = pino({ level: "silent" });
  const config: AppConfig = {
    preferredPort: 0,
    requireCallerSecret: false,
    selectedModels: [],
    accountType: "individual"
  };
  const tokenManager = new CopilotTokenManager("stub-github-token");
  // Pre-populate with a synthetic bearer so request handling skips refresh.
  preloadBearer(tokenManager);

  const port = await findFreePort();
  const proxy = await startProxyServer({
    port,
    config,
    logger,
    tokenManager,
    callerSecret: null,
    githubToken: "stub-github-token"
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    upstreamBaseUrl: upstream.baseUrl,
    setHandlers(handlers: StubProxyHandlers): void {
      currentHandlers = handlers;
    },
    close: async () => {
      try {
        await proxy.close();
      } finally {
        try {
          await upstream.close();
        } finally {
          restoreEnv();
        }
      }
    }
  };
}

function preloadBearer(tokenManager: CopilotTokenManager): void {
  // Reach in via the public `current` getter and (state field) — the manager
  // doesn't expose a public "set bearer" API. We mutate via the internal
  // field so tests don't need to wire a full token-exchange round trip.
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 3600;
  (tokenManager as unknown as { state: { token: string; expiresAtUnix: number } }).state = {
    token: "stub-bearer-token",
    expiresAtUnix
  };
}

interface StubUpstream {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startStubUpstream(opts: { handlers: () => StubProxyHandlers }): Promise<StubUpstream> {
  const server = createServer(async (req, res) => {
    const handlers = opts.handlers();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/__token") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ token: "stub-bearer-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/responses" && handlers.onResponses) {
      await handlers.onResponses(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/chat/completions" && handlers.onChatCompletions) {
      await handlers.onChatCompletions(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/models" && handlers.onModels) {
      await handlers.onModels(req, res);
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "stub_upstream_no_handler", path: url.pathname }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.listen(0, "127.0.0.1", () => resolve());
    probe.on("error", reject);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Writes the start of an SSE response and returns a writer the test can use
 * to push events or destroy the upstream socket mid-stream.
 */
export interface SseWriter {
  writeRaw: (text: string) => void;
  writeEvent: (name: string, data: unknown) => void;
  end: () => void;
  destroy: () => void;
}

export function beginSseResponse(res: ServerResponse): SseWriter {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  return {
    writeRaw(text: string) {
      res.write(text);
    },
    writeEvent(name: string, data: unknown) {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      res.end();
    },
    destroy() {
      try {
        res.socket?.destroy();
      } catch {
        // ignore
      }
    }
  };
}

export { sleep };

// Marker types so the harness module isn't pruned by tsc as unused.
export type { Server as _Server };
