import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";

import { CopilotTokenManager } from "../../src/auth/copilotToken.js";
import { startProxyServer } from "../../src/server/proxy.js";
import type { AccountResolver, ResolvedAccount } from "../../src/server/accountResolver.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * PR D — end-to-end dispatch: the proxy must forward each request to the
 * upstream using the bearer of the account selected by the URL prefix. An
 * unprefixed request uses the default account; `/<account>/...` uses that
 * named account; an unknown account answers 404.
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
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 3600;
  (manager as unknown as { state: { token: string; expiresAtUnix: number } }).state = {
    token: bearer,
    expiresAtUnix
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  return (server.address() as AddressInfo).port;
}

let upstream: Server;
let proxy: { close: () => Promise<void> };
let proxyPort: number;
let seenBearers: string[];

beforeEach(async () => {
  seenBearers = [];
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/responses" && req.method === "POST") {
      seenBearers.push(req.headers.authorization ?? "");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
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
      if (accountId === "work") {
        return workAccount;
      }
      return null;
    },
    describe() {
      return { defaultAccountId: null, activeAccountIds: ["work"] };
    },
    clearAll() {
      /* no-op for the test */
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
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function postResponses(prefix: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${proxyPort}${prefix}/codex/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", input: [] })
  });
  // Drain the body so the socket is released.
  await res.text();
  return res.status;
}

describe("proxy multi-account dispatch", () => {
  it("forwards an unprefixed request with the default account's bearer", async () => {
    const status = await postResponses("");
    expect(status).toBe(200);
    expect(seenBearers).toEqual(["Bearer bearer-default"]);
  });

  it("forwards a /<account>-prefixed request with that account's bearer", async () => {
    const status = await postResponses("/work");
    expect(status).toBe(200);
    expect(seenBearers).toEqual(["Bearer bearer-work"]);
  });

  it("answers 404 account_not_found for an unknown account prefix", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/ghost/codex/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", input: [] })
    });
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(404);
    expect(body.error).toBe("account_not_found");
    expect(seenBearers).toEqual([]);
  });
});
