import { spawn } from "node:child_process";
import { inspectStoredCredential } from "../../auth/credentials.js";
import { inspectLock } from "../../server/lock.js";
import type { LockFileData } from "../../types/index.js";
import { currentDebugLogPath } from "../shared/debug.js";
import { displayHomePath } from "../integrations/banner.js";
import { isPidAlive } from "./lifecycle.js";
import { readLiveLock, waitForDaemonReady, warnIfDebugRequestedButInactive } from "./probes.js";
import { daemonSpawnEnv } from "./spawnEnv.js";
import { buildSelfSpawnCommand } from "./selfSpawn.js";

export async function ensureDaemonRunningForLauncher(opts: { debug: boolean }): Promise<LockFileData> {
  const live = await readLiveLock();
  if (live) {
    await warnIfDebugRequestedButInactive(opts.debug, live.port);
    return live;
  }

  // Fail fast on missing credentials rather than spawning a detached daemon
  // that will die silently and surface as a generic "start timed out" error.
  const authState = await inspectStoredCredential();
  if (!authState.stored) {
    throw new Error(
      "Not authenticated. Run `copillm auth login` first."
    );
  }

  const debugLog = currentDebugLogPath(opts.debug);
  process.stderr.write(
    opts.debug && debugLog
      ? `Starting copillm in background with debug logging at ${displayHomePath(debugLog)}...\n`
      : `Starting copillm in background...\n`
  );
  const daemonCommand = buildSelfSpawnCommand("daemon", opts.debug ? ["--debug"] : []);
  const child = spawn(daemonCommand.command, daemonCommand.args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: daemonSpawnEnv(opts.debug)
  });
  child.unref();

  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  const STDERR_TAIL_LIMIT = 8 * 1024;
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > STDERR_TAIL_LIMIT && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks[0].length;
        stderrChunks.shift();
      }
    });
    child.stderr.on("error", () => {
      // Ignore — best-effort capture only.
    });
  }

  const formatStderrTail = (): string => {
    const tail = Buffer.concat(stderrChunks).toString("utf8").trim();
    return tail ? `\nDaemon stderr (tail):\n${tail}` : "";
  };

  const started = await waitForDaemonReady(child.pid ?? null, 10_000);
  if (!started) {
    if (child.pid !== undefined && !isPidAlive(child.pid)) {
      throw new Error(`copillm daemon exited before becoming ready.${formatStderrTail()}`);
    }
    throw new Error(`Auto-start of copillm daemon timed out.${formatStderrTail()}`);
  }
  const inspection = inspectLock();
  if (inspection.state !== "running") {
    throw new Error(`copillm daemon failed to register a lock after auto-start.${formatStderrTail()}`);
  }
  return inspection.lock;
}
