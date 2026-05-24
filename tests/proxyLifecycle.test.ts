import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import pino from "pino";

import {
  attachRequestLifecycle,
  isBenignSocketError,
  safeEnd,
  safeSendJson,
  safeWrite
} from "../src/server/requestLifecycle.js";

const logger = pino({ level: "silent" });

function makeFakeReqRes(): {
  req: IncomingMessage;
  res: ServerResponse;
} {
  const reqEmitter = new EventEmitter();
  const req = reqEmitter as unknown as IncomingMessage;

  const writes: string[] = [];
  const resEmitter = new EventEmitter();
  // We assemble the response on the EventEmitter instance using
  // defineProperty so the dynamic flags (headersSent / writable / etc) update
  // in place. Avoid `Object.assign` with getter literals — those snapshot at
  // assignment time and break the dynamic-state model the proxy relies on.
  const state = {
    writable: true,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    statusCode: 0,
    writes
  };
  Object.defineProperties(resEmitter, {
    writable: { get: () => state.writable, set: (v: boolean) => (state.writable = v), configurable: true },
    writableEnded: { get: () => state.writableEnded, configurable: true },
    destroyed: { get: () => state.destroyed, configurable: true },
    headersSent: { get: () => state.headersSent, configurable: true },
    statusCode: {
      get: () => state.statusCode,
      set: (v: number) => (state.statusCode = v),
      configurable: true
    },
    writes: { get: () => state.writes, configurable: true },
    setHeader: { value: (_n: string, _v: string) => resEmitter, configurable: true },
    write: {
      value: (chunk: string) => {
        writes.push(chunk);
        state.headersSent = true;
        return true;
      },
      configurable: true
    },
    end: {
      value: (chunk?: string) => {
        if (typeof chunk === "string") {
          writes.push(chunk);
          state.headersSent = true;
        }
        state.writableEnded = true;
        state.writable = false;
        return resEmitter;
      },
      configurable: true
    }
  });
  return { req, res: resEmitter as unknown as ServerResponse };
}

describe("isBenignSocketError", () => {
  it("classifies ERR_STREAM_PREMATURE_CLOSE as benign", () => {
    const err = Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" });
    expect(isBenignSocketError(err)).toBe(true);
  });
  it("classifies ECONNRESET / EPIPE / ERR_STREAM_DESTROYED / ERR_STREAM_WRITE_AFTER_END / ERR_HTTP_HEADERS_SENT as benign", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "ERR_HTTP_HEADERS_SENT"]) {
      const err = Object.assign(new Error(`code=${code}`), { code });
      expect(isBenignSocketError(err)).toBe(true);
    }
  });
  it("classifies AbortError by name as benign", () => {
    const err = new Error("Aborted");
    (err as { name: string }).name = "AbortError";
    expect(isBenignSocketError(err)).toBe(true);
  });
  it("classifies non-socket errors as non-benign", () => {
    expect(isBenignSocketError(new Error("kaboom"))).toBe(false);
    expect(isBenignSocketError(null)).toBe(false);
    expect(isBenignSocketError(undefined)).toBe(false);
    expect(isBenignSocketError("string")).toBe(false);
    expect(isBenignSocketError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
  });
  it("classifies wrapped errors via .cause as benign", () => {
    const inner = Object.assign(new Error("inner"), { code: "ECONNRESET" });
    const outer = new Error("outer");
    (outer as { cause: unknown }).cause = inner;
    expect(isBenignSocketError(outer)).toBe(true);
  });
});

describe("safeSendJson", () => {
  it("writes status, content-type, and body when response is alive", () => {
    const { res } = makeFakeReqRes();
    safeSendJson(res, 200, { ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.writableEnded).toBe(true);
    const writes = (res as unknown as { writes: string[] }).writes;
    expect(JSON.parse(writes.join(""))).toEqual({ ok: true });
  });

  it("is a no-op when headersSent is already true", () => {
    const { res } = makeFakeReqRes();
    // Simulate that streaming has begun and headers have flushed.
    res.write("event: message_start\ndata: {}\n\n");
    const writes = (res as unknown as { writes: string[] }).writes;
    const writesBefore = writes.length;
    safeSendJson(res, 500, { error: "would crash" });
    expect(writes.length).toBe(writesBefore);
    expect(res.writableEnded).toBe(false);
  });

  it("is a no-op when res.writable is false", () => {
    const { res } = makeFakeReqRes();
    (res as { writable: boolean }).writable = false;
    safeSendJson(res, 500, { error: "x" });
    const writes = (res as unknown as { writes: string[] }).writes;
    expect(writes.length).toBe(0);
  });

  it("is a no-op when res.writableEnded is true", () => {
    const { res } = makeFakeReqRes();
    res.end();
    const writes = (res as unknown as { writes: string[] }).writes;
    const writesBefore = writes.length;
    safeSendJson(res, 500, { error: "x" });
    expect(writes.length).toBe(writesBefore);
  });

  it("swallows benign socket errors thrown synchronously from end()", () => {
    const { res } = makeFakeReqRes();
    const originalEnd = res.end.bind(res);
    Object.defineProperty(res, "end", {
      value: (chunk?: string) => {
        originalEnd(chunk);
        const err = new Error("write after end") as Error & { code: string };
        err.code = "ERR_STREAM_WRITE_AFTER_END";
        throw err;
      },
      configurable: true
    });
    expect(() => safeSendJson(res, 200, { ok: true })).not.toThrow();
  });
});

describe("safeWrite", () => {
  it("writes to a live stream and returns true", () => {
    const downstream = new PassThrough();
    const ok = safeWrite(downstream, "hello");
    expect(ok).toBe(true);
  });

  it("returns false when the stream is destroyed (no throw)", () => {
    const downstream = new PassThrough();
    downstream.destroy();
    expect(safeWrite(downstream, "hello")).toBe(false);
  });

  it("returns false when the stream is ended", () => {
    const downstream = new PassThrough();
    downstream.end();
    expect(safeWrite(downstream, "hello")).toBe(false);
  });

  it("swallows benign synchronous write errors and returns false", () => {
    const downstream = new PassThrough();
    (downstream as unknown as { write: unknown }).write = () => {
      const err = new Error("EPIPE") as Error & { code: string };
      err.code = "EPIPE";
      throw err;
    };
    expect(() => safeWrite(downstream, "x")).not.toThrow();
    expect(safeWrite(downstream, "x")).toBe(false);
  });

  it("re-throws non-benign synchronous write errors", () => {
    const downstream = new PassThrough();
    (downstream as unknown as { write: unknown }).write = () => {
      throw new Error("kaboom");
    };
    expect(() => safeWrite(downstream, "x")).toThrow(/kaboom/);
  });
});

describe("safeEnd", () => {
  it("ends a live stream", () => {
    const downstream = new PassThrough();
    let ended = false;
    downstream.on("end", () => {
      ended = true;
    });
    downstream.on("data", () => {
      /* consume */
    });
    safeEnd(downstream);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(ended).toBe(true);
        resolve();
      }, 20);
    });
  });

  it("is a no-op when stream is already ended/destroyed", () => {
    const downstream = new PassThrough();
    downstream.destroy();
    expect(() => safeEnd(downstream)).not.toThrow();
  });
});

describe("attachRequestLifecycle", () => {
  it("aborts the signal when res emits 'close'", async () => {
    const { req, res } = makeFakeReqRes();
    const lifecycle = attachRequestLifecycle(req, res, logger, "req-1");
    expect(lifecycle.signal.aborted).toBe(false);
    expect(lifecycle.isAlive()).toBe(true);

    (res as unknown as EventEmitter).emit("close");

    // Give the listener a microtask to run.
    await Promise.resolve();
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.isAlive()).toBe(false);
  });

  it("aborts the signal when req emits 'aborted'", async () => {
    const { req, res } = makeFakeReqRes();
    const lifecycle = attachRequestLifecycle(req, res, logger, "req-2");

    (req as unknown as EventEmitter).emit("aborted");

    await Promise.resolve();
    expect(lifecycle.signal.aborted).toBe(true);
  });

  it("aborts the signal when res emits 'error' and does not re-throw", async () => {
    const { req, res } = makeFakeReqRes();
    const lifecycle = attachRequestLifecycle(req, res, logger, "req-3");

    const benignErr = Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" });
    (res as unknown as EventEmitter).emit("error", benignErr);

    await Promise.resolve();
    expect(lifecycle.signal.aborted).toBe(true);
  });

  it("isAlive() flips to false once writable becomes false", () => {
    const { req, res } = makeFakeReqRes();
    const lifecycle = attachRequestLifecycle(req, res, logger, "req-4");
    expect(lifecycle.isAlive()).toBe(true);
    res.end();
    expect(lifecycle.isAlive()).toBe(false);
  });

  it("calling abort multiple times is idempotent (no error)", async () => {
    const { req, res } = makeFakeReqRes();
    const lifecycle = attachRequestLifecycle(req, res, logger, "req-5");

    (res as unknown as EventEmitter).emit("close");
    (res as unknown as EventEmitter).emit("error", new Error("late"));
    (req as unknown as EventEmitter).emit("aborted");

    await Promise.resolve();
    expect(lifecycle.signal.aborted).toBe(true);
  });
});
