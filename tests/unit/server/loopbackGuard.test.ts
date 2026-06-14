import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { isLocalRequest } from "../../../src/server/routes/shared.js";

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
