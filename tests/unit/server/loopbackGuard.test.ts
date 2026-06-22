import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import {
  allowedHostHeaders,
  checkLoopbackOriginHeaders,
  isLocalRequest
} from "../../../src/server/routes/shared.js";

/**
 * The proxy binds to loopback only, but `isLocalRequest` is the second line of
 * defence: it rejects any connection whose peer address isn't a loopback
 * address (proxy.ts answers 403 `non_loopback_request_rejected` when this is
 * false). It had no direct coverage, so a refactor of the address checks could
 * silently widen access. These cases pin the accept/reject decision.
 */
function fakeRequest(remoteAddress: string | undefined, localAddress?: string | undefined): IncomingMessage {
  return { socket: { remoteAddress, localAddress } } as unknown as IncomingMessage;
}

function fakeRequestWithHeaders(headers: Record<string, string>): IncomingMessage {
  return { socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }, headers } as unknown as IncomingMessage;
}

describe("isLocalRequest", () => {
  it("accepts an IPv4 loopback peer", () => {
    expect(isLocalRequest(fakeRequest("127.0.0.1", "127.0.0.1"))).toBe(true);
  });

  it("accepts an IPv6 loopback peer", () => {
    expect(isLocalRequest(fakeRequest("::1", "::1"))).toBe(true);
  });

  it("accepts an IPv4-mapped IPv6 loopback peer", () => {
    expect(isLocalRequest(fakeRequest("::ffff:127.0.0.1", "::ffff:127.0.0.1"))).toBe(true);
  });

  it("accepts a loopback peer when the local address is unknown (empty)", () => {
    expect(isLocalRequest(fakeRequest("127.0.0.1", ""))).toBe(true);
    expect(isLocalRequest(fakeRequest("127.0.0.1", undefined))).toBe(true);
  });

  it("rejects a private LAN peer address", () => {
    expect(isLocalRequest(fakeRequest("10.0.0.5", "127.0.0.1"))).toBe(false);
    expect(isLocalRequest(fakeRequest("192.168.1.10", "127.0.0.1"))).toBe(false);
  });

  it("rejects a loopback peer reaching a non-loopback local address", () => {
    expect(isLocalRequest(fakeRequest("127.0.0.1", "10.0.0.5"))).toBe(false);
  });

  it("rejects an IPv4-mapped IPv6 non-loopback peer", () => {
    expect(isLocalRequest(fakeRequest("::ffff:192.168.0.1", "::1"))).toBe(false);
  });

  it("rejects an empty/unknown peer address", () => {
    expect(isLocalRequest(fakeRequest("", "127.0.0.1"))).toBe(false);
    expect(isLocalRequest(fakeRequest(undefined, "127.0.0.1"))).toBe(false);
  });
});

/**
 * Audit finding (high): isLocalRequest alone is NOT a sufficient defence
 * against DNS-rebinding. A web page on attacker.com that DNS-rebinds the
 * hostname to 127.0.0.1 reaches the loopback socket — and the browser treats
 * it as same-origin (no CORS preflight) so the response is readable to
 * attacker JS. The new `checkLoopbackOriginHeaders` rejects any request whose
 * Host header isn't one of `127.0.0.1:<port>`, `localhost:<port>`,
 * `[::1]:<port>`, and any cross-origin `Origin`/`Sec-Fetch-Site`.
 */
describe("allowedHostHeaders", () => {
  it("yields exactly the three loopback host:port forms", () => {
    const allowed = allowedHostHeaders(4141);
    expect(allowed.has("127.0.0.1:4141")).toBe(true);
    expect(allowed.has("localhost:4141")).toBe(true);
    expect(allowed.has("[::1]:4141")).toBe(true);
    expect(allowed.size).toBe(3);
  });

  it("changes the port part appropriately", () => {
    expect(allowedHostHeaders(9999).has("127.0.0.1:9999")).toBe(true);
    expect(allowedHostHeaders(9999).has("127.0.0.1:4141")).toBe(false);
  });
});

describe("checkLoopbackOriginHeaders", () => {
  const PORT = 4141;

  it("accepts a same-origin loopback Host with no Origin (curl, daemon-internal probes)", () => {
    const r = checkLoopbackOriginHeaders(fakeRequestWithHeaders({ host: "127.0.0.1:4141" }), PORT);
    expect(r.ok).toBe(true);
  });

  it("accepts localhost:<port> and [::1]:<port>", () => {
    expect(checkLoopbackOriginHeaders(fakeRequestWithHeaders({ host: "localhost:4141" }), PORT).ok).toBe(true);
    expect(checkLoopbackOriginHeaders(fakeRequestWithHeaders({ host: "[::1]:4141" }), PORT).ok).toBe(true);
  });

  it("normalises Host hostname comparison case-insensitively", () => {
    expect(checkLoopbackOriginHeaders(fakeRequestWithHeaders({ host: "Localhost:4141" }), PORT).ok).toBe(true);
    expect(checkLoopbackOriginHeaders(fakeRequestWithHeaders({ host: "LOCALHOST:4141" }), PORT).ok).toBe(true);
  });

  it("REJECTS a DNS-rebinding Host (attacker.example resolved to 127.0.0.1)", () => {
    const r = checkLoopbackOriginHeaders(
      fakeRequestWithHeaders({ host: "attacker.example:4141" }),
      PORT
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host_mismatch");
  });

  it("REJECTS a Host that names the right name but the wrong port", () => {
    const r = checkLoopbackOriginHeaders(fakeRequestWithHeaders({ host: "127.0.0.1:9999" }), PORT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host_mismatch");
  });

  it("REJECTS a request with no Host header", () => {
    const r = checkLoopbackOriginHeaders(fakeRequestWithHeaders({}), PORT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host_mismatch");
  });

  it("accepts a same-origin Origin: http://127.0.0.1:<port>", () => {
    const r = checkLoopbackOriginHeaders(
      fakeRequestWithHeaders({ host: "127.0.0.1:4141", origin: "http://127.0.0.1:4141" }),
      PORT
    );
    expect(r.ok).toBe(true);
  });

  it("REJECTS a cross-origin Origin from an attacker page", () => {
    const r = checkLoopbackOriginHeaders(
      fakeRequestWithHeaders({ host: "127.0.0.1:4141", origin: "http://attacker.example" }),
      PORT
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("origin_cross_site");
  });

  it("REJECTS an Origin pointing at 127.0.0.1 but the wrong port", () => {
    const r = checkLoopbackOriginHeaders(
      fakeRequestWithHeaders({ host: "127.0.0.1:4141", origin: "http://127.0.0.1:9999" }),
      PORT
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("origin_cross_site");
  });

  it("accepts the literal `Origin: null` (opaque origin: file:// pages, redirected fetches)", () => {
    // We don't try to defend against opaque-origin callers — they can't read
    // the response anyway (browser opaque-response rules). The Host check is
    // what gates browser-initiated fetches.
    const r = checkLoopbackOriginHeaders(
      fakeRequestWithHeaders({ host: "127.0.0.1:4141", origin: "null" }),
      PORT
    );
    expect(r.ok).toBe(true);
  });

  it("REJECTS Sec-Fetch-Site: cross-site", () => {
    const r = checkLoopbackOriginHeaders(
      fakeRequestWithHeaders({ host: "127.0.0.1:4141", "sec-fetch-site": "cross-site" }),
      PORT
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("sec_fetch_cross_site");
  });

  it("accepts Sec-Fetch-Site: same-origin / same-site / none", () => {
    for (const value of ["same-origin", "same-site", "none"]) {
      const r = checkLoopbackOriginHeaders(
        fakeRequestWithHeaders({ host: "127.0.0.1:4141", "sec-fetch-site": value }),
        PORT
      );
      expect(r.ok, `value=${value}`).toBe(true);
    }
  });
});
