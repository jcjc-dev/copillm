import { randomUUID } from "node:crypto";
import { loadStoredCredential } from "../../auth/credentials.js";
import { CopilotTokenManager } from "../../auth/copilotToken.js";
import { loadConfig } from "../../config/config.js";
import { acquireLock, LockAlreadyRunningError, releaseLock } from "../../server/lock.js";
import { startProxyServer } from "../../server/proxy.js";
import type { LockFileData } from "../../types/index.js";
import { installProcessSafetyNet } from "../processSafetyNet.js";
import { getRootLogger } from "../shared/debug.js";
import { withTimeout } from "./lifecycle.js";
import { probeLivez } from "./probes.js";

export function candidatePorts(preferredPort: number): number[] {
  const ports: number[] = [];
  for (let offset = 0; offset < 10; offset += 1) {
    const port = preferredPort + offset;
    if (port <= 65535) {
      ports.push(port);
    }
  }
  return ports;
}

export function isAddrInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "EADDRINUSE";
}

export async function runDaemon(options?: { debug?: boolean }): Promise<
  | { kind: "started"; port: number; callerSecret: null | string }
  | { kind: "already_running"; lock: LockFileData }
> {
  const logger = getRootLogger();
  const config = loadConfig();
  const creds = await loadStoredCredential();
  if (!creds) {
    throw new Error("Not authenticated. Run `copillm login` first.");
  }

  const tokenManager = new CopilotTokenManager(creds.token);
  await tokenManager.ensureToken(false);

  const callerSecret = config.requireCallerSecret ? randomUUID() : null;
  if (callerSecret) {
    process.stdout.write(`Caller secret: ${callerSecret}\n`);
  }

  const ports = candidatePorts(config.preferredPort);
  let server: null | { close: () => Promise<void> } = null;
  let selectedPort: null | number = null;

  for (const port of ports) {
    try {
      await acquireLock(port, { isRunning: async (lock) => probeLivez(lock.port) });
    } catch (error) {
      if (error instanceof LockAlreadyRunningError) {
        tokenManager.clear();
        return { kind: "already_running", lock: error.lock };
      }
      throw error;
    }

    try {
      server = await startProxyServer({
        port,
        config,
        tokenManager,
        callerSecret,
        logger,
        debug: Boolean(options?.debug),
        githubToken: creds.token
      });
      selectedPort = port;
      break;
    } catch (error) {
      releaseLock();
      if (isAddrInUse(error)) {
        continue;
      }
      throw error;
    }
  }

  if (!server || selectedPort === null) {
    tokenManager.clear();
    throw new Error(`No available port in configured range (${ports[0]}-${ports[ports.length - 1]}).`);
  }

  installProcessSafetyNet(logger);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await withTimeout(server.close(), 5_000, "Timed out while draining requests.");
    } catch (error) {
      logger.warn({ err: error }, "graceful shutdown timed out");
    } finally {
      tokenManager.clear();
      releaseLock();
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  return { kind: "started", port: selectedPort, callerSecret };
}
