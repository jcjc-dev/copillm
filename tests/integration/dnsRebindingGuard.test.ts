import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";

import { startStubProxyHarness, type StubProxyHarness } from "../helpers/stubProxyHarness.js";

/**
 * Audit finding (high): the proxy used to gate access on TCP-peer-loopback
 * alone — anything that arrived on the loopback socket was served. That left
 * the daemon open to DNS-rebinding: a web page on attacker.com that
 * DNS-rebinds the hostname to 127.0.0.1 reaches the loopback socket, the
 * browser treats it as same-origin (no CORS preflight), and the response
 * (model output, debug info, Copilot quota) leaks to attacker JS.
 *
 * The runtime fix lives in `src/server/proxy.ts` and `src/server/routes/shared.ts`:
 *   • allow only Host = `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`
 *   • allow only Origin = http://<one of those>
 *   • reject Sec-Fetch-Site = cross-site
 *
 * These integration tests hit the real `startProxyServer` with raw http.request
 * so we can stuff any Host header we like — `fetch()` would normalise it for us.
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

interface RawResponse {
  statusCode: number;
  body: string;
  parsed: Record<string, unknown>;
}

function rawGet(path: string, headers: Record<string, string>): Promise<RawResponse> {
  if (!harness) throw new Error("harness not started");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: harness!.port,
        path,
        method: "GET",
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(body) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          resolve({ statusCode: res.statusCode ?? 0, body, parsed });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function rawPost(path: string, headers: Record<string, string>, body: string): Promise<RawResponse> {
  if (!harness) throw new Error("harness not started");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: harness!.port,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          resolve({ statusCode: res.statusCode ?? 0, body: text, parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("DNS-rebinding defence: Host header gate", () => {
  it("accepts a baseline /livez with Host = 127.0.0.1:<port>", async () => {
    if (!harness) throw new Error("harness not started");
    const r = await rawGet("/livez", { Host: `127.0.0.1:${harness.port}` });
    expect(r.statusCode).toBe(200);
  });

  it("accepts a baseline /healthz with Host = localhost:<port>", async () => {
    if (!harness) throw new Error("harness not started");
    const r = await rawGet("/healthz", { Host: `localhost:${harness.port}` });
    expect(r.statusCode).toBe(200);
  });

  it("REJECTS /livez when Host is a rebound attacker hostname", async () => {
    if (!harness) throw new Error("harness not started");
    const r = await rawGet("/livez", { Host: `attacker.example:${harness.port}` });
    expect(r.statusCode).toBe(421);
    expect(r.parsed).toMatchObject({ error: "misdirected_request" });
  });

  it("REJECTS /healthz when Host names the right hostname but a wrong port", async () => {
    if (!harness) throw new Error("harness not started");
    // The port is part of the Host check, so a rebinding attacker who guesses
    // the wrong port (or scans by trying multiple) is denied.
    const r = await rawGet("/healthz", { Host: `127.0.0.1:${harness.port + 1}` });
    expect(r.statusCode).toBe(421);
    expect(r.parsed).toMatchObject({ error: "misdirected_request" });
  });

  it("REJECTS the proxy chat-completions route with a rebound Host", async () => {
    if (!harness) throw new Error("harness not started");
    const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    const r = await rawPost(
      "/v1/chat/completions",
      { Host: `evil.example:${harness.port}` },
      body
    );
    expect(r.statusCode).toBe(421);
    expect(r.parsed).toMatchObject({ error: "misdirected_request" });
  });

  it("REJECTS the proxy anthropic route with a cross-origin Origin", async () => {
    if (!harness) throw new Error("harness not started");
    const body = JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "hi" }] });
    const r = await rawPost(
      "/v1/messages",
      { Host: `127.0.0.1:${harness.port}`, Origin: "http://attacker.example" },
      body
    );
    expect(r.statusCode).toBe(403);
    expect(r.parsed).toMatchObject({ error: "cross_origin_rejected" });
  });

  it("REJECTS when Sec-Fetch-Site: cross-site is set", async () => {
    if (!harness) throw new Error("harness not started");
    const r = await rawGet("/healthz", {
      Host: `127.0.0.1:${harness.port}`,
      "Sec-Fetch-Site": "cross-site"
    });
    expect(r.statusCode).toBe(403);
    expect(r.parsed).toMatchObject({ error: "cross_origin_rejected" });
  });
});
