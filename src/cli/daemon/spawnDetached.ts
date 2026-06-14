import { spawn } from "node:child_process";
import { waitForDaemonReady } from "./probes.js";
import { buildSelfSpawnCommand } from "./selfSpawn.js";
import { daemonSpawnEnv } from "./spawnEnv.js";

/**
 * Spawn the daemon as a detached background process and wait until it is
 * reachable. Shared by `copillm start --detach` and `copillm restart` so the
 * two paths can never drift in how they launch the background daemon.
 *
 * `forcePort` pins the daemon back onto a specific port (used by `restart` to
 * rebind the port the previous daemon was running on); when null the daemon
 * falls back to the normal configured-port scan.
 */
export async function spawnDetachedDaemon(input: {
  debug: boolean;
  forcePort?: number | null;
}): Promise<{ pid: number; port: number }> {
  const daemonCommand = buildSelfSpawnCommand("daemon", input.debug ? ["--debug"] : []);
  const child = spawn(daemonCommand.command, daemonCommand.args, {
    detached: true,
    stdio: "ignore",
    env: daemonSpawnEnv(input.debug, { port: input.forcePort ?? null })
  });
  child.unref();

  const started = await waitForDaemonReady(child.pid ?? null, 8_000);
  if (!started) {
    throw new Error("Detached daemon start timed out.");
  }
  return started;
}
