import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Companion to authStatusCli.test.ts: rather than asserting the no-leak
// invariant, this suite stands up a tiny in-process /user mock so we can
// verify the positive path — that `copillm auth status` actually surfaces
// the GitHub login behind the stored credential.
//
// Hermetic by construction: the mock binds 127.0.0.1:0, the CLI is pointed
// at it via COPILLM_GITHUB_USER_URL, and no real api.github.com call is made.

const SECRET_TOKEN = "gho_NEVER_LEAK_THIS_TOKEN_xyz9876543210ABC";
const MOCK_LOGIN = "copillm-cli-test-user";
const MOCK_NAME = "Copillm CLI Test User";

type MockMode =
  | "ok"
  | "malformed-json"
  | "http-401"
  | "http-500"
  | "name-null"
  | "name-matches-login"
  | "missing-login";

let tmpHome: string | undefined;
let mockServer: Server | undefined;
let mockUserUrl: string | undefined;
let lastAuthHeader: null | string = null;
let mockMode: MockMode = "ok";

const cliPath = path.resolve(__dirname, "..", "..", "dist", "cli.js");

function ensureCliBuilt(): void {
  // CLI is built once via vitest globalSetup (tests/globalBuild.ts); see
  // that file for why per-file builds were removed.
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI artifact missing at ${cliPath} — globalSetup did not run.`);
  }
}

async function startMockUserServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    lastAuthHeader = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : null;
    if (req.url !== "/user") {
      res.statusCode = 404;
      res.end();
      return;
    }
    switch (mockMode) {
      case "malformed-json":
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        // Deliberately broken JSON with html-looking content (e.g., a captive
        // portal or GitHub maintenance page that lies about its content-type).
        res.end("<html>not really json {{</html>");
        return;
      case "http-401":
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "Bad credentials" }));
        return;
      case "http-500":
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "internal server error" }));
        return;
      case "name-null":
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            login: MOCK_LOGIN,
            id: 42,
            name: null,
            type: "User"
          })
        );
        return;
      case "name-matches-login":
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            login: MOCK_LOGIN,
            id: 42,
            name: MOCK_LOGIN,
            type: "User"
          })
        );
        return;
      case "missing-login":
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: 42,
            name: MOCK_NAME,
            type: "User"
          })
        );
        return;
      case "ok":
      default:
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            login: MOCK_LOGIN,
            id: 42,
            name: MOCK_NAME,
            email: "noreply@example.invalid",
            type: "User",
            avatar_url: null,
            html_url: null,
            plan: { name: "test" }
          })
        );
        return;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}/user` };
}

beforeAll(async () => {
  ensureCliBuilt();

  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-authuser-"));
  fs.mkdirSync(tmpHome, { recursive: true });
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

  const started = await startMockUserServer();
  mockServer = started.server;
  mockUserUrl = started.url;
});

afterAll(async () => {
  if (mockServer) {
    await new Promise<void>((resolve, reject) => {
      mockServer!.close((err) => (err ? reject(err) : resolve()));
    });
  }
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function runCli(args: string[], envOverride: Record<string, undefined | string> = {}): Promise<{ stdout: string; stderr: string; code: null | number }> {
  if (!tmpHome || !mockUserUrl) {
    throw new Error("test setup did not complete");
  }
  lastAuthHeader = null;
  // Use async spawn (not spawnSync) so the parent event loop keeps running
  // while the child executes — otherwise the in-process mock /user server
  // can't accept the CLI's connection and every fetch hangs to the timeout.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        COPILLM_HOME: tmpHome,
        COPILLM_FORCE_SESSION_BACKEND: undefined as unknown as string,
        COPILLM_GITHUB_USER_URL: mockUserUrl,
        ...envOverride
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI child timed out after 15s. Partial stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000);
    child.on("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      resolve({ stdout, stderr, code });
    });
  });
}

function withMockMode<T>(mode: MockMode, fn: () => Promise<T>): Promise<T> {
  const prev = mockMode;
  mockMode = mode;
  return fn().finally(() => {
    mockMode = prev;
  });
}

describe("auth status surfaces GitHub login", () => {
  it("human output includes the @login and display name", async () => {
    const { stdout, code } = await runCli(["auth", "status"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`@${MOCK_LOGIN}`);
    expect(stdout).toContain(MOCK_NAME);
    expect(stdout).toContain("logged in");
    expect(stdout).not.toContain(SECRET_TOKEN);
    expect(lastAuthHeader).toBe(`token ${SECRET_TOKEN}`);
  });

  it("--json includes a user block with login and name", async () => {
    const { stdout, code } = await runCli(["auth", "status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { user?: { login?: string; name?: string | null } };
    expect(parsed.user?.login).toBe(MOCK_LOGIN);
    expect(parsed.user?.name).toBe(MOCK_NAME);
    expect(stdout).not.toContain(SECRET_TOKEN);
  });

  it("--no-user skips the lookup and falls back to the backend-only line", async () => {
    const { stdout, code } = await runCli(["auth", "status", "--no-user"]);
    expect(code).toBe(0);
    expect(stdout).toContain("logged in");
    expect(stdout).not.toContain(`@${MOCK_LOGIN}`);
    expect(lastAuthHeader).toBeNull();
  });

  it("--json --no-user emits user: null without hitting the mock", async () => {
    const { stdout, code } = await runCli(["auth", "status", "--json", "--no-user"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { user: unknown };
    expect(parsed.user).toBeNull();
    expect(lastAuthHeader).toBeNull();
  });

  it("gracefully falls back when /user is unreachable", async () => {
    const { stdout, code } = await runCli(["auth", "status"], {
      COPILLM_GITHUB_USER_URL: "http://127.0.0.1:1/never"
    });
    expect(code).toBe(0);
    expect(stdout).toContain("logged in");
    expect(stdout).not.toContain(`@${MOCK_LOGIN}`);
    expect(stdout).not.toContain(SECRET_TOKEN);
  });

  it("gracefully falls back when /user returns HTTP 200 with malformed JSON", async () => {
    // A captive portal or upstream maintenance page that lies about its
    // content-type would cause response.json() to throw a SyntaxError, which
    // is not a GithubUserFetchError. The wrapper must still catch it.
    await withMockMode("malformed-json", async () => {
      const { stdout, code } = await runCli(["auth", "status"]);
      expect(code).toBe(0);
      expect(stdout).toContain("logged in");
      expect(stdout).not.toContain(`@${MOCK_LOGIN}`);
      expect(stdout).not.toContain(SECRET_TOKEN);
    });
  });

  it("gracefully falls back when /user returns HTTP 401 (expired token)", async () => {
    await withMockMode("http-401", async () => {
      const { stdout, stderr, code } = await runCli(["auth", "status"]);
      expect(code).toBe(0);
      expect(stdout).toContain("logged in");
      expect(stdout).not.toContain(`@${MOCK_LOGIN}`);
      expect(stderr).not.toContain(SECRET_TOKEN);
      expect(stderr).toBe("");
    });
  });

  it("gracefully falls back when /user returns HTTP 500", async () => {
    await withMockMode("http-500", async () => {
      const { stdout, code } = await runCli(["auth", "status"]);
      expect(code).toBe(0);
      expect(stdout).toContain("logged in");
      expect(stdout).not.toContain(`@${MOCK_LOGIN}`);
    });
  });

  it("omits the parenthesised name when /user returns name: null", async () => {
    await withMockMode("name-null", async () => {
      const { stdout, code } = await runCli(["auth", "status"]);
      expect(code).toBe(0);
      expect(stdout).toContain(`@${MOCK_LOGIN}`);
      expect(stdout).not.toContain("(null)");
      // Format should be `logged in as @login (<backend>)` with no `(name)` suffix.
      expect(stdout).toMatch(new RegExp(`logged in as @${MOCK_LOGIN} \\(`));
    });
  });

  it("omits the parenthesised name when /user returns name equal to login", async () => {
    await withMockMode("name-matches-login", async () => {
      const { stdout, code } = await runCli(["auth", "status"]);
      expect(code).toBe(0);
      // Must not see `@login (login)` — only the backend in parens.
      expect(stdout).not.toContain(`@${MOCK_LOGIN} (${MOCK_LOGIN})`);
      expect(stdout).toContain(`@${MOCK_LOGIN}`);
    });
  });

  it("falls back to the backend-only line when /user payload has no login", async () => {
    await withMockMode("missing-login", async () => {
      const { stdout, code } = await runCli(["auth", "status"]);
      expect(code).toBe(0);
      expect(stdout).toContain("logged in");
      expect(stdout).not.toContain("@");
    });
  });
});
