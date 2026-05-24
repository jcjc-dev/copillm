import { createConnection, type Socket } from "node:net";

/**
 * Helpers for driving the proxy with a raw TCP socket so we can simulate
 * mid-stream client disconnects, malformed HTTP, request-body aborts, etc.
 * Node's `fetch` is too well-behaved to easily reproduce these scenarios.
 */

export interface RawResponse {
  raw: Buffer;
  headersText: string;
  body: Buffer;
  status: number | null;
}

export function buildHttpRequest(opts: {
  method: string;
  path: string;
  host?: string;
  port: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): Buffer {
  const headers: Record<string, string> = {
    Host: `${opts.host ?? "127.0.0.1"}:${opts.port}`,
    Connection: "close",
    ...(opts.headers ?? {})
  };
  if (opts.body !== undefined && headers["Content-Length"] === undefined) {
    const bodyLen = Buffer.byteLength(opts.body);
    headers["Content-Length"] = String(bodyLen);
  }
  const headerLines = [
    `${opts.method} ${opts.path} HTTP/1.1`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "",
    ""
  ];
  const top = Buffer.from(headerLines.join("\r\n"), "utf8");
  if (opts.body === undefined) {
    return top;
  }
  return Buffer.concat([top, Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf8")]);
}

/**
 * Send a raw HTTP request, wait until some bytes of the response have
 * arrived (so the proxy has committed headers), then forcibly destroy the
 * socket. Returns the partial response we did receive.
 */
export async function sendThenDestroy(opts: {
  port: number;
  request: Buffer;
  waitForBytes?: number;
  timeoutMs?: number;
}): Promise<RawResponse> {
  const waitForBytes = opts.waitForBytes ?? 64;
  const timeoutMs = opts.timeoutMs ?? 4000;

  return new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let destroyed = false;
    const socket = createConnection({ host: "127.0.0.1", port: opts.port });

    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(new Error(`sendThenDestroy timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(opts.request);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (!destroyed && received >= waitForBytes) {
        destroyed = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        clearTimeout(timer);
        setTimeout(() => resolve(buildRawResponse(Buffer.concat(chunks))), 50);
      }
    });
    socket.on("error", () => {
      // closing the socket frequently surfaces as an error; ignore
    });
    socket.on("close", () => {
      if (!destroyed) {
        destroyed = true;
        clearTimeout(timer);
        resolve(buildRawResponse(Buffer.concat(chunks)));
      }
    });
  });
}

/**
 * Send raw bytes, then forcibly drop the socket WITHOUT waiting for any
 * response. Useful for malformed-HTTP / partial-body scenarios where the
 * proxy might never produce response bytes.
 */
export async function sendAndDropImmediately(opts: {
  port: number;
  payload: Buffer;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: opts.port });
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
    socket.on("connect", () => {
      try {
        socket.write(opts.payload);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      setTimeout(() => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        clearTimeout(timer);
        resolve();
      }, 50);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Full request → drain → close helper for non-streaming sanity checks
 * ("daemon still serves the next request").
 */
export async function rawHttpRoundtrip(opts: {
  port: number;
  request: Buffer;
  timeoutMs?: number;
}): Promise<RawResponse> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  return new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port: opts.port });
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(new Error(`rawHttpRoundtrip timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("connect", () => socket.write(opts.request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(buildRawResponse(Buffer.concat(chunks)));
    });
  });
}

function buildRawResponse(raw: Buffer): RawResponse {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep < 0) {
    return { raw, headersText: raw.toString("utf8"), body: Buffer.alloc(0), status: null };
  }
  const headersText = raw.slice(0, sep).toString("utf8");
  const body = raw.slice(sep + 4);
  const firstLine = headersText.split("\r\n")[0] ?? "";
  const match = /^HTTP\/\d\.\d\s+(\d+)/.exec(firstLine);
  return {
    raw,
    headersText,
    body,
    status: match ? Number.parseInt(match[1] ?? "0", 10) : null
  };
}

export async function waitForSocketClosed(socket: Socket, timeoutMs = 1000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
