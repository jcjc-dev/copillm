import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startMockBackend, type MockBackend } from "../mock-backend/server.js";
import { seedFreshHome, type SeededHome } from "../e2e/seed-credentials.js";

/**
 * End-to-end coverage that `copillm status --json` reports the daemon's
 * actual running version (from `/healthz`) alongside the CLI's package
 * version, and flags an update when they diverge.
 *
 * We fake the daemon's package version with the `COPILLM_PACKAGE_NAME` +
 * `COPILLM_PACKAGE_VERSION` env-var override that `getPackageInfo()` already
 * honours (`src/config/packageInfo.ts`). This lets the test pin both the
 * daemon's reported version AND the CLI's self-reported version without
 * touching the on-disk package.json, so the assertions are stable across
 * real release version bumps.
 *
 * Registry lookup is disabled (`NO_UPDATE_NOTIFIER=1`) so the test never
 * hits npmjs.org and the assertions don't drift when a new copillm version
 * is published.
 */

const CLI_ENTRY = path.resolve(__dirname, "..", "..", "dist", "cli.js");

let mock: MockBackend | null = null;
let seeded: SeededHome | null = null;

afterEach(async () => {
  if (seeded) {
    spawnSync(process.execPath, [CLI_ENTRY, "stop", "--json"], {
      env: cliEnv(seeded.copillmHome, mock, { COPILLM_PACKAGE_NAME: "copillm", COPILLM_PACKAGE_VERSION: "0.4.2" }),
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

describe("copillm status — daemon version reporting", () => {
  it(
    "status --json reports daemon_version + cli_version and matches when daemon and cli agree",
    async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();
    const port = await findFreePort();
    writeConfig(seeded.copillmHome, port);

    const env = { COPILLM_PACKAGE_NAME: "copillm", COPILLM_PACKAGE_VERSION: "9.8.7" };
    const start = await runCli(["start", "--detach", "--no-codex", "--no-pi", "--json"], env);
    expect(start.status, start.stderr).toBe(0);

    const status = await runCli(["status", "--json", "--no-registry-check"], env);
    expect(status.status, status.stderr).toBe(0);
    const payload = JSON.parse(status.stdout) as {
      running: boolean;
      daemon_version: string | null;
      cli_version: string;
      latest_version: string | null;
      update_available: boolean;
      version_hint: string | null;
    };

    expect(payload.running).toBe(true);
    expect(payload.daemon_version).toBe("9.8.7");
    expect(payload.cli_version).toBe("9.8.7");
    expect(payload.latest_version).toBeNull();
    expect(payload.update_available).toBe(false);
    expect(payload.version_hint).toBeNull();
  },
    30_000
  );

  it(
    "status flags a stale daemon when the CLI was upgraded but the daemon was not restarted",
    async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();
    const port = await findFreePort();
    writeConfig(seeded.copillmHome, port);

    // Daemon is started pretending to be the OLD version on disk.
    const daemonEnv = { COPILLM_PACKAGE_NAME: "copillm", COPILLM_PACKAGE_VERSION: "0.4.2" };
    const start = await runCli(["start", "--detach", "--no-codex", "--no-pi", "--json"], daemonEnv);
    expect(start.status, start.stderr).toBe(0);

    // …then the user runs `npm install -g copillm` (CLI bumps to 0.4.3) and
    // runs `copillm status` BEFORE restarting. Status should tell them.
    const cliEnvNew = { COPILLM_PACKAGE_NAME: "copillm", COPILLM_PACKAGE_VERSION: "0.4.3" };
    const status = await runCli(["status", "--json", "--no-registry-check"], cliEnvNew);
    expect(status.status, status.stderr).toBe(0);
    const payload = JSON.parse(status.stdout) as {
      daemon_version: string | null;
      cli_version: string;
      update_available: boolean;
      version_hint: string | null;
    };

    expect(payload.daemon_version).toBe("0.4.2");
    expect(payload.cli_version).toBe("0.4.3");
    expect(payload.update_available).toBe(true);
    expect(payload.version_hint).toBe("restart to apply cli v0.4.3");
  },
    30_000
  );

  it(
    "status (text) surfaces the version line + hint in human output",
    async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();
    const port = await findFreePort();
    writeConfig(seeded.copillmHome, port);

    const start = await runCli(
      ["start", "--detach", "--no-codex", "--no-pi", "--json"],
      { COPILLM_PACKAGE_NAME: "copillm", COPILLM_PACKAGE_VERSION: "0.4.2" }
    );
    expect(start.status, start.stderr).toBe(0);

    const status = await runCli(["status", "--no-registry-check"], {
      COPILLM_PACKAGE_NAME: "copillm",
      COPILLM_PACKAGE_VERSION: "0.4.3"
    });
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toMatch(/version: 0\.4\.2 \(cli 0\.4\.3\) — restart to apply cli v0\.4\.3/);
  },
    30_000
  );

  it(
    "status reports cli_version even when the daemon is not running",
    async () => {
    mock = await startMockBackend();
    seeded = seedFreshHome();

    // Note: no `start`.
    const status = await runCli(["status", "--json", "--no-registry-check"], {
      COPILLM_PACKAGE_NAME: "copillm",
      COPILLM_PACKAGE_VERSION: "1.2.3"
    });
    expect(status.status, status.stderr).toBe(0);
    const payload = JSON.parse(status.stdout) as {
      running: boolean;
      daemon_version: string | null;
      cli_version: string;
      update_available: boolean;
      version_hint: string | null;
    };
    expect(payload.running).toBe(false);
    expect(payload.daemon_version).toBeNull();
    expect(payload.cli_version).toBe("1.2.3");
    expect(payload.update_available).toBe(false);
    expect(payload.version_hint).toBeNull();
  },
    30_000
  );
});

function runCli(args: string[], extraEnv: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: cliEnv(seeded!.copillmHome, mock, extraEnv),
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

function cliEnv(copillmHome: string, backend: MockBackend | null, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COPILLM_HOME: copillmHome,
    CLAUDE_CONFIG_DIR: path.join(copillmHome, "claude", "home"),
    NO_UPDATE_NOTIFIER: "1",
    ...(backend
      ? {
          COPILLM_UPSTREAM_BASE_URL: backend.baseUrl,
          COPILLM_TOKEN_EXCHANGE_URL: backend.tokenExchangeUrl,
          COPILLM_GITHUB_USER_URL: backend.githubUserUrl
        }
      : {}),
    ...extraEnv
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
