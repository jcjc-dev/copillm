import type { Command } from "commander";
import { inspectStoredCredential, type CredentialBackend } from "../../auth/credentials.js";
import { loadConfig } from "../../config/config.js";
import { getCopillmHome } from "../../config/home.js";
import { clearClaudeGatewayCache } from "../../integrations/claude/cache.js";
import { resolveStartContext, type PrecomputedStartContext } from "../../integrations/codex/init.js";
import { inspectLock, releaseLock } from "../../server/lock.js";
import { buildCodexEnvBundle } from "../agentEnv.js";
import { ensureAuthenticatedInteractive } from "../auth/ensure.js";
import { computeUptimeSeconds, formatUptime, stopByPid } from "../daemon/lifecycle.js";
import { probeDebugEndpoint, probeHealth, readLiveLock, warnIfDebugRequestedButInactive } from "../daemon/probes.js";
import { runDaemon } from "../daemon/runDaemon.js";
import { buildClaudeExportCommand } from "../integrations/claudeExport.js";
import { formatStartBanner, formatStopHumanLine, displayHomePath } from "../integrations/banner.js";
import { refreshCodexHome } from "../integrations/refreshCodex.js";
import { refreshPiHome } from "../integrations/refreshPi.js";
import { writeAuthStatusLine } from "../shared/backends.js";
import { currentDebugLogPath, enableRuntimeDebug, getRootLogger, resolveCopillmDebug } from "../shared/debug.js";
import { isDevModeActive } from "../shared/devMode.js";
import { writeCommandOutput, writeHealthOutput } from "../shared/output.js";
import { spawnDetachedDaemon } from "../daemon/spawnDetached.js";
import { resolveRestartDecision, type DaemonLockState } from "../daemon/restart.js";

export function register(program: Command): void {
  program
    .command("start")
    .description("Start proxy")
    .option("--detach", "Run in detached mode")
    .option("--debug", "Enable debug endpoints (e.g. /_debug)")
    .option("--no-codex", "Skip generating ~/.copillm/codex/ for Codex CLI")
    .option("--codex-model <id>", "Default Codex model slug")
    .option("--no-pi", "Skip generating the copillm-owned pi models.json for pi coding agent")
    .option("--json", "JSON output")
    .action(async (opts: { detach?: boolean; debug?: boolean; codex?: boolean; codexModel?: string; pi?: boolean; json?: boolean }) => {
      const debug = resolveCopillmDebug(opts.debug);
      enableRuntimeDebug(debug);
      if (isDevModeActive()) {
        process.stderr.write(`dev mode: isolated COPILLM_HOME ${displayHomePath(getCopillmHome())}\n`);
      }
      if (opts.detach) {
        // Fail fast on missing credentials rather than letting the detached
        // child die silently and surface as a generic "start timed out" error.
        const authState = await inspectStoredCredential();
        if (!authState.stored) {
          throw new Error(
            "Not authenticated. Run `copillm auth login` first, or start without --detach to log in interactively."
          );
        }

        const existingLock = await readLiveLock();
        if (existingLock) {
          const activeDebug = await warnIfDebugRequestedButInactive(debug, existingLock.port);
          const shared = await loadSharedStartContextIfNeeded(opts);
          const codex = opts.codex === false ? null : await refreshCodexHome(existingLock.port, opts.codexModel ?? null, shared);
          const pi = opts.pi === false ? null : await refreshPiHome(existingLock.port, shared);
          const claude = buildClaudeExportCommand(existingLock.port, null);
          const banner = formatStartBanner({
            port: existingLock.port,
            pid: existingLock.pid,
            mode: "already_running",
            debug: activeDebug,
            debugLogPath: null,
            codex,
            pi
          });
          writeCommandOutput(opts, banner, {
            status: "already_running",
            pid: existingLock.pid,
            port: existingLock.port,
            debug: activeDebug,
            url: `http://127.0.0.1:${existingLock.port}`,
            codex_home: codex?.outDir ?? null,
            codex_export_command: codex?.exportCommand ?? null,
            codex_env: codex ? buildCodexEnvBundle(codex.outDir).env : null,
            pi_home: pi?.outDir ?? null,
            pi_config_path: pi?.configPath ?? null,
            pi_mirror_path: pi?.mirrorPath ?? null,
            pi_backup_path: pi?.backupPath ?? null,
            pi_model_count: pi?.modelCount ?? null,
            claude_export_command: claude.command,
            claude_env: claude.bundle.env,
            claude_defaults: claude.defaults
          });
          return;
        }

        const started = await spawnDetachedDaemon({ debug });
        await emitDetachedStartOutput(opts, started, debug, "detached");
        return;
      }

      // Foreground path: interactively prompt for login if needed.
      await ensureAuthenticatedInteractive();

      const started = await runDaemon({ debug });
      if (started.kind === "already_running") {
        const activeDebug = await warnIfDebugRequestedButInactive(debug, started.lock.port);
        const sharedAlready = await loadSharedStartContextIfNeeded(opts);
        const codex = opts.codex === false ? null : await refreshCodexHome(started.lock.port, opts.codexModel ?? null, sharedAlready);
        const pi = opts.pi === false ? null : await refreshPiHome(started.lock.port, sharedAlready);
        const claude = buildClaudeExportCommand(started.lock.port, null);
        const banner = formatStartBanner({
          port: started.lock.port,
          pid: started.lock.pid,
          mode: "already_running",
          debug: activeDebug,
          debugLogPath: null,
          codex,
          pi
        });
        writeCommandOutput(opts, banner, {
          status: "already_running",
          pid: started.lock.pid,
          port: started.lock.port,
          debug: activeDebug,
          url: `http://127.0.0.1:${started.lock.port}`,
          codex_home: codex?.outDir ?? null,
          codex_export_command: codex?.exportCommand ?? null,
          codex_env: codex ? buildCodexEnvBundle(codex.outDir).env : null,
          pi_home: pi?.outDir ?? null,
          pi_config_path: pi?.configPath ?? null,
          pi_mirror_path: pi?.mirrorPath ?? null,
          pi_backup_path: pi?.backupPath ?? null,
          pi_model_count: pi?.modelCount ?? null,
          claude_export_command: claude.command,
          claude_env: claude.bundle.env,
          claude_defaults: claude.defaults
        });
        return;
      }

      const sharedForeground = await loadSharedStartContextIfNeeded(opts);
      const codex = opts.codex === false ? null : await refreshCodexHome(started.port, opts.codexModel ?? null, sharedForeground);
      const pi = opts.pi === false ? null : await refreshPiHome(started.port, sharedForeground);
      const claude = buildClaudeExportCommand(started.port, started.callerSecret);
      const banner = formatStartBanner({
        port: started.port,
        pid: process.pid,
        mode: "foreground",
        debug,
        debugLogPath: currentDebugLogPath(debug),
        codex,
        pi
      });

      writeCommandOutput(opts, banner, {
        status: "ok",
        mode: "foreground",
        pid: process.pid,
        port: started.port,
        debug,
        debug_log_path: currentDebugLogPath(debug),
        url: `http://127.0.0.1:${started.port}`,
        caller_secret: started.callerSecret,
        codex_home: codex?.outDir ?? null,
        codex_export_command: codex?.exportCommand ?? null,
        codex_env: codex ? buildCodexEnvBundle(codex.outDir).env : null,
        codex_default_model: codex?.defaultModel ?? null,
        codex_model_count: codex?.modelCount ?? null,
        pi_home: pi?.outDir ?? null,
        pi_config_path: pi?.configPath ?? null,
        pi_mirror_path: pi?.mirrorPath ?? null,
        pi_backup_path: pi?.backupPath ?? null,
        pi_model_count: pi?.modelCount ?? null,
        claude_export_command: claude.command,
        claude_env: claude.bundle.env,
        claude_defaults: claude.defaults
      });
    });

  program
    .command("restart")
    .description("Restart the daemon, preserving its current port and debug mode")
    .option("--debug", "Force debug endpoints on for the restarted daemon")
    .option("--no-codex", "Skip generating ~/.copillm/codex/ for Codex CLI")
    .option("--codex-model <id>", "Default Codex model slug")
    .option("--no-pi", "Skip generating the copillm-owned pi models.json for pi coding agent")
    .option("--json", "JSON output")
    .action(async (opts: { debug?: boolean; codex?: boolean; codexModel?: string; pi?: boolean; json?: boolean }) => {
      const forceDebug = resolveCopillmDebug(opts.debug);
      if (isDevModeActive()) {
        process.stderr.write(`dev mode: isolated COPILLM_HOME ${displayHomePath(getCopillmHome())}\n`);
      }

      // Restart always brings the daemon back up detached, so fail fast on
      // missing credentials rather than letting the detached child die silently.
      const authState = await inspectStoredCredential();
      if (!authState.stored) {
        throw new Error("Not authenticated. Run `copillm auth login` first.");
      }

      // Detect the running daemon's debug mode *before* stopping it — `/_debug`
      // is only reachable while the daemon is up.
      const lockSnapshot = toDaemonLockState(inspectLock());
      const detectedDebug =
        lockSnapshot.state === "running" ? await probeDebugEndpoint(lockSnapshot.port) : false;
      const decision = resolveRestartDecision({ lock: lockSnapshot, detectedDebug, forceDebug });
      enableRuntimeDebug(decision.debug);

      if (decision.action === "restart" && decision.previousPid !== null) {
        await stopByPid(decision.previousPid);
      } else if (decision.clearStaleLock) {
        releaseLock();
      }
      // Mirror `stop`: clearing the Claude gateway cache on the way down keeps
      // Claude Code from pinning a stale model picker across the restart.
      const cache = clearClaudeGatewayCache();

      const started = await spawnDetachedDaemon({ debug: decision.debug, forcePort: decision.forcePort });
      await emitDetachedStartOutput(opts, started, decision.debug, "restarted", {
        previousPid: decision.previousPid,
        claudeCache: cache
      });
    });

  program
    .command("daemon")
    .description("Internal background command")
    .option("--debug", "Enable debug endpoints")
    .action(async (opts: { debug?: boolean }) => {
      const debug = resolveCopillmDebug(opts.debug);
      enableRuntimeDebug(debug);
      try {
        const started = await runDaemon({ debug });
        if (started.kind === "already_running") {
          process.exit(0);
        }
        process.stdout.write(`copillm listening on http://127.0.0.1:${started.port}${debug ? " [debug]" : ""}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        getRootLogger().fatal({ err }, "daemon failed to start");
        process.stderr.write(`copillm daemon: ${message}\n`);
        process.exit(1);
      }
    });

  program
    .command("stop")
    .description("Stop detached daemon")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const lockState = inspectLock();
      if (lockState.state === "missing") {
        const cache = clearClaudeGatewayCache();
        writeCommandOutput(opts, formatStopHumanLine("Not running.", cache), {
          status: "not_running",
          claude_cache: cache
        });
        return;
      }
      if (lockState.state === "stale") {
        releaseLock();
        const cache = clearClaudeGatewayCache();
        writeCommandOutput(opts, formatStopHumanLine("Removed stale lock.", cache), {
          status: "stale_lock_removed",
          reason: lockState.reason,
          claude_cache: cache
        });
        return;
      }

      await stopByPid(lockState.lock.pid);
      const cache = clearClaudeGatewayCache();
      writeCommandOutput(opts, formatStopHumanLine("Stopped.", cache), {
        status: "ok",
        pid: lockState.lock.pid,
        claude_cache: cache
      });
    });

  program
    .command("status")
    .description("Show daemon status")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      const lockState = inspectLock();
      const checkedAtIso = new Date().toISOString();
      const uptimeSeconds = lockState.state === "running" ? computeUptimeSeconds(lockState.lock.started_at_iso) : null;

      // inspectStoredCredential never returns the token itself, so it's safe to
      // include the result in the status payload.
      let authInfo: { stored: boolean; backend: null | CredentialBackend; error: null | string };
      try {
        const info = await inspectStoredCredential();
        authInfo = { stored: info.stored, backend: info.backend, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        authInfo = { stored: false, backend: null, error: message };
      }

      const status = {
        running: lockState.state === "running",
        stale: lockState.state === "stale",
        copillm_home: getCopillmHome(),
        dev_mode: isDevModeActive(),
        pid: lockState.state === "running" ? lockState.lock.pid : null,
        port: lockState.state === "running" ? lockState.lock.port : null,
        started_at_iso: lockState.state === "running" ? lockState.lock.started_at_iso : null,
        uptime_seconds: uptimeSeconds,
        uptime_human: uptimeSeconds === null ? null : formatUptime(uptimeSeconds),
        url: lockState.state === "running" ? `http://127.0.0.1:${lockState.lock.port}` : null,
        require_caller_secret: config.requireCallerSecret,
        account_type: config.accountType,
        selected_models: config.selectedModels,
        auth: authInfo,
        bearer_ttl_seconds: null as null | number,
        health_check_status_code: null as null | number,
        health_state: null as null | string,
        health_error: null as null | string,
        health_status: "unknown" as "ok" | "degraded" | "unknown",
        checked_at_iso: checkedAtIso,
        stale_reason: lockState.state === "stale" ? lockState.reason : null
      };

      if (lockState.state === "running") {
        const health = await probeHealth(lockState.lock.port);
        status.health_status = health.ok ? "ok" : "degraded";
        status.bearer_ttl_seconds = health.bearerTtlSeconds;
        status.health_check_status_code = health.statusCode;
        status.health_state = health.status;
        status.health_error = health.error;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + "\n");
        return;
      }

      process.stdout.write(`home: ${displayHomePath(status.copillm_home)}${status.dev_mode ? " (dev)" : ""}\n`);

      if (lockState.state === "running") {
        process.stdout.write(`running (pid ${lockState.lock.pid}, port ${lockState.lock.port})\n`);
        process.stdout.write(`health: ${status.health_status}`);
        if (status.health_state) {
          process.stdout.write(` (${status.health_state})`);
        }
        if (status.health_check_status_code !== null) {
          process.stdout.write(` [http ${status.health_check_status_code}]`);
        }
        if (status.health_error) {
          process.stdout.write(` error=${status.health_error}`);
        }
        process.stdout.write("\n");
        if (status.bearer_ttl_seconds !== null) {
          process.stdout.write(`bearer_ttl_seconds: ${status.bearer_ttl_seconds}\n`);
        }
        if (status.uptime_seconds !== null) {
          process.stdout.write(`uptime: ${formatUptime(status.uptime_seconds)} (${status.uptime_seconds}s)\n`);
        }
        writeAuthStatusLine(authInfo);
        process.stdout.write(`checked_at: ${status.checked_at_iso}\n`);
        return;
      }
      if (lockState.state === "stale") {
        process.stdout.write(`stale lock (${lockState.reason})\n`);
        writeAuthStatusLine(authInfo);
        return;
      }
      process.stdout.write("not running\n");
      writeAuthStatusLine(authInfo);
    });

  program
    .command("health")
    .description("Check health endpoint")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const lockState = inspectLock();
      if (lockState.state !== "running") {
        const payload = {
          ok: false,
          status: lockState.state === "stale" ? "stale_lock" : "not_running",
          detail: lockState.state === "stale" ? lockState.reason : "Daemon is not running."
        };
        writeHealthOutput(opts, payload);
        process.exitCode = 1;
        return;
      }

      // Route the /healthz check through `probeHealth` so we inherit retry
      // on transient transport errors AND a try/catch that turns a transient
      // ECONNRESET into a structured `health_probe_failed` result instead of
      // a raw stack trace. The previous bare `fetch` had no try/catch and
      // would crash `copillm health` if the daemon had just been killed
      // between `inspectLock` and the request.
      const health = await probeHealth(lockState.lock.port);
      const payload: Record<string, unknown> = {
        ok: health.ok,
        status_code: health.statusCode
      };
      if (health.status !== null) payload.status = health.status;
      if (health.error !== null) payload.error = health.error;
      if (health.bearerTtlSeconds !== null) payload.bearer_ttl_seconds = health.bearerTtlSeconds;
      writeHealthOutput(opts, payload);
      if (!health.ok) {
        process.exitCode = 1;
      }
    });
}

/**
 * Emit the human banner + JSON payload for a daemon that was just brought up in
 * the background. Shared by `copillm start --detach` (`mode: "detached"`) and
 * `copillm restart` (`mode: "restarted"`), so both surface the same codex/pi/
 * claude wiring. `extra` carries restart-only fields (`previous_pid`, the
 * Claude cache-clear result).
 */
async function emitDetachedStartOutput(
  opts: { json?: boolean; codex?: boolean; codexModel?: string; pi?: boolean },
  started: { pid: number; port: number },
  debug: boolean,
  mode: "detached" | "restarted",
  extra?: { previousPid?: number | null; claudeCache?: { cleared: boolean; reason: null | string } }
): Promise<void> {
  const shared = await loadSharedStartContextIfNeeded(opts);
  const codex = opts.codex === false ? null : await refreshCodexHome(started.port, opts.codexModel ?? null, shared);
  const pi = opts.pi === false ? null : await refreshPiHome(started.port, shared);
  const claude = buildClaudeExportCommand(started.port, null);
  const banner = formatStartBanner({
    port: started.port,
    pid: started.pid,
    mode,
    debug,
    debugLogPath: currentDebugLogPath(debug),
    codex,
    pi
  });

  const payload: Record<string, unknown> = {
    status: "ok",
    mode,
    pid: started.pid,
    port: started.port,
    debug,
    debug_log_path: currentDebugLogPath(debug),
    url: `http://127.0.0.1:${started.port}`,
    codex_home: codex?.outDir ?? null,
    codex_export_command: codex?.exportCommand ?? null,
    codex_env: codex ? buildCodexEnvBundle(codex.outDir).env : null,
    codex_default_model: codex?.defaultModel ?? null,
    codex_model_count: codex?.modelCount ?? null,
    pi_home: pi?.outDir ?? null,
    pi_config_path: pi?.configPath ?? null,
    pi_mirror_path: pi?.mirrorPath ?? null,
    pi_backup_path: pi?.backupPath ?? null,
    pi_model_count: pi?.modelCount ?? null,
    claude_export_command: claude.command,
    claude_env: claude.bundle.env,
    claude_defaults: claude.defaults
  };
  if (extra?.previousPid !== undefined) {
    payload.previous_pid = extra.previousPid;
  }
  if (extra?.claudeCache !== undefined) {
    payload.claude_cache = extra.claudeCache;
  }
  writeCommandOutput(opts, banner, payload);
}

/** Narrow the lock inspection down to the shape `resolveRestartDecision` needs. */
function toDaemonLockState(lockState: ReturnType<typeof inspectLock>): DaemonLockState {
  if (lockState.state === "running") {
    return { state: "running", pid: lockState.lock.pid, port: lockState.lock.port };
  }
  if (lockState.state === "stale") {
    return { state: "stale" };
  }
  return { state: "missing" };
}

/**
 * Load the shared credential/config/discovery context for `copillm start`'s
 * codex + pi init steps, ONLY when at least one of them is going to run.
 *
 * Without sharing, each step independently re-reads the OS keychain, re-parses
 * the YAML config, and re-fetches the upstream `/models` catalog. With this
 * helper, the work happens once and both steps see the same snapshot.
 *
 * When both `--no-codex` and `--no-pi` are passed (or both wrappers will skip
 * for some other reason), there's no consumer for the context, so we skip
 * the loads entirely — important for `copillm start --no-codex --no-pi` to
 * stay fast and not surface a credential error if the user genuinely just
 * wants the proxy daemon up.
 *
 * Returning `undefined` (not `null`) so it composes naturally with the
 * `precomputed?: PrecomputedStartContext` optional parameter on both
 * `refreshCodexHome` and `refreshPiHome`.
 */
async function loadSharedStartContextIfNeeded(opts: {
  codex?: boolean;
  pi?: boolean;
}): Promise<PrecomputedStartContext | undefined> {
  if (opts.codex === false && opts.pi === false) {
    return undefined;
  }
  try {
    return await resolveStartContext();
  } catch {
    // If the load fails (e.g. no credentials, model discovery down), fall
    // back to per-wrapper loads so each one can fail loudly with its own
    // wrapper-specific warning. The wrappers already have try/catch that
    // emit `warning: failed to generate ...` lines — preserving that
    // surface keeps the user-visible behaviour unchanged from before.
    return undefined;
  }
}
