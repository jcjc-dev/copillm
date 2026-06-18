import { describe, expect, it } from "vitest";
import http from "node:http";

import { handleHealthz, handleLivez } from "../../../src/server/routes/health.js";
import type { CopilotTokenManager } from "../../../src/auth/copilotToken.js";

/**
 * Direct unit coverage that `/healthz` and `/livez` include the running
 * daemon's package version in their response bodies. The status command
 * surfaces this so users can tell whether a `copillm restart` is needed
 * after `npm install -g copillm`.
 *
 * We construct a tiny `http.ServerResponse` against a real loopback request
 * so we exercise the actual `safeSendJson` write path and JSON shape — not a
 * partial mock that would let the wire format drift silently.
 */

interface CapturedResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

async function captureResponse(handler: (res: http.ServerResponse) => unknown): Promise<CapturedResponse> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (_req, res) => {
      try {
        const chunks: Buffer[] = [];
        // Intercept writes so we can capture even after end().
        const origEnd = res.end.bind(res);
        const origWrite = res.write.bind(res);
        res.write = ((chunk: string | Buffer) => {
          if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
          else chunks.push(chunk);
          return true;
        }) as typeof res.write;
        res.end = ((chunk?: string | Buffer) => {
          if (chunk) {
            if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
            else chunks.push(chunk);
          }
          origEnd();
          void origWrite;
          return res;
        }) as typeof res.end;

        await handler(res);

        server.close();
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        resolve({ statusCode: res.statusCode, body });
      } catch (error) {
        server.close();
        reject(error);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      void fetch(`http://127.0.0.1:${addr.port}/`).catch(() => {
        // The handler resolves the outer promise — we just need to provoke a request.
      });
    });
  });
}

function freshTokenManager(ttlSeconds: number | null): CopilotTokenManager {
  return {
    expiresInSeconds: () => ttlSeconds,
    async ensureToken() {
      // Token already considered fresh; nothing to do.
    }
  } as unknown as CopilotTokenManager;
}

describe("/livez", () => {
  it("includes the daemon's package version in the payload", async () => {
    const captured = await captureResponse((res) => handleLivez(res, { version: "9.8.7" }));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      status: "ok",
      version: "9.8.7"
    });
    expect(typeof captured.body.uptime_seconds).toBe("number");
  });
});

describe("/healthz", () => {
  it("includes the daemon's package version on the fresh-token fast path", async () => {
    const tm = freshTokenManager(3_600);
    const captured = await captureResponse((res) => handleHealthz(res, tm, { version: "1.2.3" }));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      status: "ok",
      token_state: "fresh",
      version: "1.2.3"
    });
  });

  it("includes the daemon's package version on the token-refresh path", async () => {
    let ttl: number | null = 5;
    const tm = {
      expiresInSeconds: () => ttl,
      async ensureToken() {
        ttl = 1_800;
      }
    } as unknown as CopilotTokenManager;
    const captured = await captureResponse((res) => handleHealthz(res, tm, { version: "1.2.3" }));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      status: "ok",
      token_state: "refreshed",
      version: "1.2.3"
    });
  });

  it("includes the daemon's package version even when the token refresh fails", async () => {
    const tm = {
      expiresInSeconds: () => 5,
      async ensureToken() {
        throw new Error("kaboom");
      }
    } as unknown as CopilotTokenManager;
    const captured = await captureResponse((res) => handleHealthz(res, tm, { version: "1.2.3" }));
    expect(captured.statusCode).toBeGreaterThanOrEqual(400);
    expect(captured.body.version).toBe("1.2.3");
  });
});
