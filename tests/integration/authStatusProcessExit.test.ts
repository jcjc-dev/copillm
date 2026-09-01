import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET_TOKEN = "gho_STATUS_PROCESS_EXIT_TOKEN";
const cliPath = path.resolve(__dirname, "..", "..", "dist", "cli.js");

let tmpHome: string | undefined;
let userServer: Server | undefined;
let userUrl: string | undefined;

function ensureCliBuilt(): void {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI artifact missing at ${cliPath} — globalSetup did not run.`);
  }
}

beforeAll(async () => {
  ensureCliBuilt();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-auth-status-exit-"));
  fs.writeFileSync(
    path.join(tmpHome, "credentials.json"),
    JSON.stringify(
      {
        version: 1,
        github_token: SECRET_TOKEN,
        account_type: "individual",
        saved_at: new Date().toISOString()
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  userServer = createServer((request, response) => {
    if (request.url !== "/user") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ login: "status-user", id: 42, name: null }));
  });

  await new Promise<void>((resolve, reject) => {
    userServer?.once("error", reject);
    userServer?.listen(0, "127.0.0.1", () => {
      const address = userServer?.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test user server did not expose a TCP address."));
        return;
      }
      userUrl = `http://127.0.0.1:${address.port}/user`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (userServer) {
    await new Promise<void>((resolve, reject) => {
      userServer?.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe("CLI auth status process lifecycle", () => {
  it("exits cleanly after a successful GitHub identity lookup", async () => {
    if (!tmpHome || !userUrl) {
      throw new Error("Test setup did not complete.");
    }

    const result = await new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, "auth", "status", "--json"], {
        env: {
          ...process.env,
          COPILLM_HOME: tmpHome,
          COPILLM_GITHUB_USER_URL: userUrl
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("auth status child process timed out."));
      }, 15_000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(timeout);
        resolve({ status, stderr, stdout });
      });
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("UV_HANDLE_CLOSING");
    expect(result.stdout).not.toContain(SECRET_TOKEN);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      stored: boolean;
      user: { login: string } | null;
    };
    expect(payload.status).toBe("logged_in");
    expect(payload.stored).toBe(true);
    expect(payload.user?.login).toBe("status-user");
  });
});
