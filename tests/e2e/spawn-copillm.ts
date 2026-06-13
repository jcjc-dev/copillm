import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface CopillmDaemon {
  pid: number;
  port: number;
  baseUrl: string;
  callerSecret: null | string;
  fakeHome: string;
  child: ChildProcess;
  stop: () => Promise<void>;
}

export interface StartCopillmOptions {
  copillmHome: string;
  upstreamBaseUrl: string;
  tokenExchangeUrl: string;
  githubUserUrl: string;
  port?: number;
  debug?: boolean;
  cliEntry: string;
  /** Skip writing pi's models.json (default false: pi is generated into the fake HOME). */
  skipPi?: boolean;
}

export async function startCopillmAgainstMock(options: StartCopillmOptions): Promise<CopillmDaemon> {
  const args = [options.cliEntry, "start"];
  if (options.debug) args.push("--debug");
  args.push("--no-codex");
  if (options.skipPi) args.push("--no-pi");

  // Isolate HOME so nothing the daemon spawns can touch the developer's real
  // home. copillm now writes pi's models.json under COPILLM_HOME (via the
  // PI_CODING_AGENT_DIR override), not ~/.pi, but we keep HOME isolated anyway.
  const fakeHome = path.join(options.copillmHome, "fake-home");
  fs.mkdirSync(fakeHome, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    COPILLM_HOME: options.copillmHome,
    COPILLM_UPSTREAM_BASE_URL: options.upstreamBaseUrl,
    COPILLM_TOKEN_EXCHANGE_URL: options.tokenExchangeUrl,
    COPILLM_GITHUB_USER_URL: options.githubUserUrl
  };

  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });

  const earlyExit = new Promise<never>((_, reject) => {
    child.once("exit", (code) => {
      reject(new Error(`copillm daemon exited early code=${code}\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`));
    });
  });

  const portPromise = waitForListeningPort(stdoutBufRef(() => stdoutBuf));
  const port = await Promise.race([portPromise, earlyExit]);

  await waitForLivez(port);

  return {
    pid: child.pid ?? -1,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    callerSecret: null,
    fakeHome,
    child,
    stop: () => stopChild(child)
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (child.exitCode !== null) return;
    await sleep(50);
  }
  child.kill("SIGKILL");
}

function stdoutBufRef(reader: () => string): { read(): string } {
  return { read: reader };
}

async function waitForListeningPort(buf: { read(): string }, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const portRegex = /listening on http:\/\/127\.0\.0\.1:(\d+)|running on http:\/\/127\.0\.0\.1:(\d+)/;
  while (Date.now() < deadline) {
    const text = buf.read();
    const match = text.match(portRegex);
    if (match) {
      return Number.parseInt(match[1] ?? match[2] ?? "0", 10);
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for copillm to print listening port. Captured stdout:\n${buf.read()}`);
}

async function waitForLivez(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/livez`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for /livez on port ${port}`);
}
