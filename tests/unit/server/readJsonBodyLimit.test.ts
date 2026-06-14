import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MAX_REQUEST_BYTES, maxRequestBytes, readJson } from "../../../src/server/routes/shared.js";
import { RequestBodyTooLargeError } from "../../../src/server/errors.js";

function bodyStream(chunks: Buffer[]): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage;
}

const ORIGINAL_MAX = process.env.COPILLM_MAX_REQUEST_BYTES;

afterEach(() => {
  if (ORIGINAL_MAX === undefined) {
    delete process.env.COPILLM_MAX_REQUEST_BYTES;
  } else {
    process.env.COPILLM_MAX_REQUEST_BYTES = ORIGINAL_MAX;
  }
});

describe("readJson body-size limit", () => {
  it("parses a body under the limit", async () => {
    const parsed = await readJson(bodyStream([Buffer.from('{"a":1}')]), 1000);
    expect(parsed).toEqual({ a: 1 });
  });

  it("returns {} for an empty body", async () => {
    const parsed = await readJson(bodyStream([]), 1000);
    expect(parsed).toEqual({});
  });

  it("allows a body whose size is exactly the limit", async () => {
    const body = Buffer.from('"aaaaaaaa"'); // 10 bytes
    const parsed = await readJson(bodyStream([body]), body.length);
    expect(parsed).toBe("aaaaaaaa");
  });

  it("rejects a body one byte over the limit", async () => {
    const body = Buffer.from('"aaaaaaaa"'); // 10 bytes
    await expect(readJson(bodyStream([body]), body.length - 1)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects once cumulative chunks exceed the limit (no full buffering)", async () => {
    const chunks = [Buffer.alloc(50), Buffer.alloc(50), Buffer.alloc(50)];
    await expect(readJson(bodyStream(chunks), 120)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});

describe("maxRequestBytes", () => {
  it("defaults when the env var is unset", () => {
    delete process.env.COPILLM_MAX_REQUEST_BYTES;
    expect(maxRequestBytes()).toBe(DEFAULT_MAX_REQUEST_BYTES);
  });

  it("honors a valid positive integer override", () => {
    process.env.COPILLM_MAX_REQUEST_BYTES = "4096";
    expect(maxRequestBytes()).toBe(4096);
  });

  it("falls back to the default for invalid or non-positive values", () => {
    for (const value of ["0", "-5", "abc", "1.5", ""]) {
      process.env.COPILLM_MAX_REQUEST_BYTES = value;
      expect(maxRequestBytes()).toBe(DEFAULT_MAX_REQUEST_BYTES);
    }
  });
});
