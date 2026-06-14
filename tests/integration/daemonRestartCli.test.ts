import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startMockBackend, type MockBackend } from "../mock-backend/server.js";
import { seedFreshHome, type SeededHome } from "../e2e/seed-credentials.js";

const CLI_ENTRY = path.resolve(__dirname, "..", "..", "dist", "cli.js");

let mock: MockBackend | null = null;
let seeded: SeededHome | null = null;

afterEach(async () => {
  if (seeded) {
    // `stop` only signals an existing daemon + clears the cache (no network),
    // so a synchronous call is fine here.
    spawnSync(process.execPath, [CLI_ENTRY, "stop", "--json"], {
      env: cliEnv(seeded.copillmHome, mock),
      encoding: "utf8",
      timeout: 15_000
    });
  }
  if (mock) {
    await mock.close();
    mock = null;
  }
  if (seeded) {
    seeded.cleanup();
    seeded = null;
  }
});

describe("copillm restart", () => {
  it("restarts on the same port with a new pid and reports the previous one", async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();
    const port = await findFreePort();
    writeConfig(seeded.copillmHome, port);

    const start = await runCli(["start", "--detach", "--no-codex", "--no-pi", "--json"]);
    expect(start.status, start.stderr).toBe(0);
    const startPayload = JSON.parse(start.stdout) as { pid: number; port: number };
    expect(startPayload.port).toBe(port);

    const restart = await runCli(["restart", "--no-codex", "--no-pi", "--json"]);
    expect(restart.status, restart.stderr).toBe(0);
    const restartPayload = JSON.parse(restart.stdout) as {
      mode: string;
      pid: number;
      port: number;
      previous_pid: number | null;
      debug: boolean;
    };

    expect(restartPayload.mode).toBe("restarted");
    expect(restartPayload.port).toBe(port);
    expect(restartPayload.previous_pid).toBe(startPayload.pid);
    expect(restartPayload.pid).not.toBe(startPayload.pid);
    expect(restartPayload.debug).toBe(false);

    const livez = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(livez.ok).toBe(true);
  });

  it("preserves debug mode across a restart that does not pass --debug", async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();
    const port = await findFreePort();
    writeConfig(seeded.copillmHome, port);

    const start = await runCli(["--debug", "start", "--detach", "--no-codex", "--no-pi", "--json"]);
    expect(start.status, start.stderr).toBe(0);
    expect((JSON.parse(start.stdout) as { debug: boolean }).debug).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/_debug`)).status).toBe(200);

    const restart = await runCli(["restart", "--no-codex", "--no-pi", "--json"]);
    expect(restart.status, restart.stderr).toBe(0);
    const restartPayload = JSON.parse(restart.stdout) as { debug: boolean; port: number };
    expect(restartPayload.port).toBe(port);
    expect(restartPayload.debug).toBe(true);

    // `/_debug` is only mounted in debug mode, so a 200 here proves the
    // restarted daemon came back up with debug still on.
    expect((await fetch(`http://127.0.0.1:${port}/_debug`)).status).toBe(200);
  });

  it("starts a fresh daemon when none is running", async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();
    const port = await findFreePort();
    writeConfig(seeded.copillmHome, port);

    const restart = await runCli(["restart", "--no-codex", "--no-pi", "--json"]);
    expect(restart.status, restart.stderr).toBe(0);
    const restartPayload = JSON.parse(restart.stdout) as {
      mode: string;
      previous_pid: number | null;
      port: number;
    };
    expect(restartPayload.mode).toBe("restarted");
    expect(restartPayload.previous_pid).toBeNull();
    expect(restartPayload.port).toBe(port);

    const livez = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(livez.ok).toBe(true);
  });
});

// Async spawn (not spawnSync): the mock backend runs in this worker process, so
// blocking the event loop would stop it from answering the detached daemon's
// token-exchange request and the daemon would never come up.
function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: cliEnv(seeded!.copillmHome, mock),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

function cliEnv(copillmHome: string, backend: MockBackend | null): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COPILLM_HOME: copillmHome,
    // Pin Claude's config home into the temp dir so the restart's gateway-cache
    // clear can never touch a real ~/.claude, even if the host exports
    // CLAUDE_CONFIG_DIR.
    CLAUDE_CONFIG_DIR: path.join(copillmHome, "claude", "home"),
    ...(backend
      ? {
          COPILLM_UPSTREAM_BASE_URL: backend.baseUrl,
          COPILLM_TOKEN_EXCHANGE_URL: backend.tokenExchangeUrl,
          COPILLM_GITHUB_USER_URL: backend.githubUserUrl
        }
      : {})
  };
}

function writeConfig(copillmHome: string, port: number): void {
  fs.writeFileSync(
    path.join(copillmHome, "config.yaml"),
    `preferredPort: ${port}\nrequireCallerSecret: false\nselectedModels: []\naccountType: individual\n`
  );
}

async function findFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate free port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
