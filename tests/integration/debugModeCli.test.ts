import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startMockBackend, type MockBackend } from "../mock-backend/server.js";
import { seedFreshHome, type SeededHome } from "../e2e/seed-credentials.js";

const CLI_ENTRY = path.resolve(__dirname, "..", "..", "dist", "cli.js");

let mock: MockBackend | null = null;
let seeded: SeededHome | null = null;
let child: ChildProcess | null = null;
let shimDir: string | null = null;

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child);
  }
  child = null;
  if (seeded) {
    spawnSync(process.execPath, [CLI_ENTRY, "stop", "--json"], {
      env: stopEnv(seeded.copillmHome),
      encoding: "utf8",
      timeout: 10_000
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
  if (shimDir) {
    fs.rmSync(shimDir, { recursive: true, force: true });
    shimDir = null;
  }
});

describe("global copillm --debug", () => {
  it("claims --debug (short alias of --copillm-debug) and does not forward it to the agent", async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();
    const port = await findFreePort();
    fs.writeFileSync(
      path.join(seeded.copillmHome, "config.yaml"),
      `preferredPort: ${port}\nrequireCallerSecret: false\nselectedModels: []\naccountType: individual\n`
    );

    child = spawn(process.execPath, [CLI_ENTRY, "--debug", "start", "--no-codex", "--no-pi"], {
      env: testEnv(seeded.copillmHome, mock),
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout = await waitForStdout(child, /\[debug\]/);
    expect(stdout).toContain(`http://127.0.0.1:${port}`);

    const debugResponse = await fetch(`http://127.0.0.1:${port}/_debug`);
    expect(debugResponse.status).toBe(200);
    const debugBody = (await debugResponse.json()) as {
      debug_enabled?: boolean;
      server?: { log_level?: string; log_file?: string | null };
      user?: Record<string, unknown> | null;
    };
    expect(debugBody.debug_enabled).toBe(true);
    expect(debugBody.server?.log_level).toBe("debug");

    // PII guard: /_debug should only expose login/id/type from the GitHub user
    // summary. The mock backend's fixtureUserPayload returns name, email,
    // avatar_url, html_url, and plan — none of those may leak through.
    expect(debugBody.user).toBeTruthy();
    expect(Object.keys(debugBody.user ?? {}).sort()).toEqual(["id", "login", "type"]);
    for (const forbidden of ["name", "email", "avatar_url", "html_url", "plan_name", "plan"]) {
      expect(debugBody.user).not.toHaveProperty(forbidden);
    }

    const capturePath = path.join(seeded.copillmHome, "claude-argv.json");
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-debug-shim-"));
    writeClaudeShim(shimDir, capturePath);

    const launched = spawnSync(
      process.execPath,
      [CLI_ENTRY, "--debug", "claude", "--copillm-no-config", "--debug", "--probe"],
      {
        env: {
          ...testEnv(seeded.copillmHome, mock),
          PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
          // Stubbed claude binary lives on PATH for this test; opt in to PATH lookup.
          COPILLM_USE_SYSTEM_AGENT: "1"
        },
        encoding: "utf8",
        timeout: 30_000
      }
    );
    expect(launched.error, launched.error?.message).toBeUndefined();
    expect(launched.status, launched.stderr).toBe(0);

    const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as { argv: string[] };
    // --debug is a copillm short alias for --copillm-debug; copillm consumes
    // it (here, the trailing one passed after `claude`) and the agent never
    // sees it. --probe is an unrelated agent flag and must still pass through.
    expect(capture.argv).not.toContain("--debug");
    expect(capture.argv).toContain("--probe");
  });

  it("writes detached daemon diagnostics to the debug log file", async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();
    const port = await findFreePort();
    fs.writeFileSync(
      path.join(seeded.copillmHome, "config.yaml"),
      `preferredPort: ${port}\nrequireCallerSecret: false\nselectedModels: []\naccountType: individual\n`
    );

    const started = await runCli(
      ["--debug", "start", "--detach", "--no-codex", "--no-pi", "--json"],
      testEnv(seeded.copillmHome, mock)
    );
    expect(started.status, started.stderr).toBe(0);

    const payload = JSON.parse(started.stdout) as { debug?: boolean; debug_log_path?: string };
    expect(payload.debug).toBe(true);
    expect(payload.debug_log_path).toBe(path.join(seeded.copillmHome, "debug.log"));

    const debugResponse = await fetch(`http://127.0.0.1:${port}/_debug`);
    expect(debugResponse.status).toBe(200);
    const debugBody = (await debugResponse.json()) as {
      server?: { log_file?: string | null };
    };
    expect(debugBody.server?.log_file).toBe(payload.debug_log_path);
    await waitForFileIncludes(payload.debug_log_path!, "http_request");

    const stopped = spawnSync(process.execPath, [CLI_ENTRY, "stop", "--json"], {
      env: { ...testEnv(seeded.copillmHome, mock), ...stopEnv(seeded.copillmHome) },
      encoding: "utf8",
      timeout: 30_000
    });
    expect(stopped.status, stopped.stderr).toBe(0);
  });
});

function testEnv(copillmHome: string, backend: MockBackend): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COPILLM_HOME: copillmHome,
    COPILLM_UPSTREAM_BASE_URL: backend.baseUrl,
    COPILLM_TOKEN_EXCHANGE_URL: backend.tokenExchangeUrl,
    COPILLM_GITHUB_USER_URL: backend.githubUserUrl
  };
}

function stopEnv(copillmHome: string): NodeJS.ProcessEnv {
  const fakeHome = path.join(copillmHome, "fake-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  return {
    ...process.env,
    COPILLM_HOME: copillmHome,
    HOME: fakeHome,
    USERPROFILE: fakeHome
  };
}

function writeClaudeShim(dir: string, capturePath: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const script =
    `const fs = require("node:fs");\n` +
    `const argv = process.argv.slice(2);\n` +
    `if (argv[0] === "--version") { process.stdout.write("debug-shim 0.0.0\\n"); process.exit(0); }\n` +
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv }, null, 2));\n`;
  if (process.platform === "win32") {
    const jsPath = path.join(dir, "claude.js");
    fs.writeFileSync(jsPath, script);
    fs.writeFileSync(path.join(dir, "claude.cmd"), `@node "${jsPath}" %*\r\n`);
    return;
  }
  fs.writeFileSync(path.join(dir, "claude"), `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
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

async function waitForStdout(process: ChildProcess, pattern: RegExp): Promise<string> {
  let stdout = "";
  let stderr = "";
  process.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  process.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pattern.test(stdout)) {
      return stdout;
    }
    if (process.exitCode !== null) {
      throw new Error(`process exited before matching ${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function waitForExit(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForFileIncludes(filePath: string, needle: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(needle)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${filePath} to contain ${needle}`);
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
