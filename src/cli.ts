#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import { clearStoredCredential, inspectStoredCredential, loadStoredCredential, saveStoredCredential, type CredentialBackend } from "./auth/credentials.js";
import { inspectGithubIdentity, type GithubIdentitySummary } from "./auth/githubIdentity.js";
import { ensureAuthenticatedInteractive as ensureAuthenticatedInteractiveImpl, type EnsureAuthenticatedDeps } from "./auth/ensureAuthenticated.js";
import { loginViaDeviceFlow } from "./auth/deviceFlow.js";
import { CopilotTokenManager } from "./auth/copilotToken.js";
import { confirm, choose } from "./auth/interactivePrompt.js";
import { loadConfig, saveConfig } from "./config/config.js";
import { createLogger } from "./config/logging.js";
import { listModels, resolveModelSelections } from "./models/discovery.js";
import { acquireLock, inspectLock, LockAlreadyRunningError, releaseLock } from "./server/lock.js";
import { startProxyServer } from "./server/proxy.js";
import {
  defaultOutputDir,
  generateCodexHome
} from "./integrations/codex/init.js";
import {
  defaultOutputDir as defaultPiOutputDir,
  generatePiHome,
  type PiInitResult
} from "./integrations/pi/init.js";
import { debugLogPath, getCopillmHome } from "./config/home.js";
import { clearClaudeGatewayCache } from "./integrations/claude/cache.js";
import { detectClaudeSettingsConflicts, formatSettingsConflictWarning } from "./integrations/claude/settingsConflict.js";
import {
  buildClaudeExportCommand as buildClaudeExport,
  computeAnthropicDefaults,
  readModelIdsFromCache,
  type AnthropicDefaults
} from "./models/anthropicDefaults.js";
import type { LockFileData } from "./types/index.js";
import { isShellSyntax, renderEnvBlock, type ShellSyntax } from "./cli/envBlock.js";
import { buildClaudeEnvBundle, buildCodexEnvBundle, buildPiEnvBundle, type ClaudeEnvBundle, type CodexEnvBundle } from "./cli/agentEnv.js";
import { launchAgent } from "./cli/launchAgent.js";
import type { AgentName } from "./integrations/registry.js";
import { applyAgentConfig, formatApplyNotes } from "./agentconfig/apply.js";
import { applyYolo, resolveYolo } from "./agents/registry.js";
import { registerConfigCommands } from "./cli/configCommands.js";
import { installProcessSafetyNet } from "./cli/processSafetyNet.js";

const logger = createLogger();
const program = new Command();

// Resolve the package version from package.json at runtime so `--version` stays
// in sync with whatever was published. Using createRequire keeps this working
// under NodeNext ESM without needing an import-assertion syntax flag, and
// resolves the same file in both `dist/cli.js` (one level deep) and `src/cli.ts`
// when invoked via tsx.
const pkgVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

program.name("copillm").description("Local Copilot proxy").version(pkgVersion);
program.enablePositionalOptions();
program.option("--debug", "Enable copillm debug mode (debug endpoint plus verbose daemon diagnostics)");

program
  .command("login")
  .description("[deprecated] Use `copillm auth login`")
  .option("--json", "JSON output")
  .action(async (opts: { json?: boolean }) => {
    emitDeprecation(opts, "login", "auth login");
    await runAuthLogin(opts, { forceSession: false });
  });

program
  .command("logout")
  .description("[deprecated] Use `copillm auth logout`")
  .option("--json", "JSON output")
  .action(async (opts: { json?: boolean }) => {
    emitDeprecation(opts, "logout", "auth logout");
    await runAuthLogout(opts);
  });

const auth = program.command("auth").description("Authentication commands");

auth
  .command("login")
  .description("Authenticate with GitHub")
  .option("--json", "JSON output")
  // Undocumented test seam: force the session-only backend regardless of
  // whether the OS keychain is available. Equivalent to setting
  // COPILLM_FORCE_SESSION_BACKEND=1 for the duration of this command.
  .option("--force-session", "(test-only) force the session-only backend", false)
  .action(async (opts: { json?: boolean; forceSession?: boolean }) => {
    await runAuthLogin(opts, { forceSession: Boolean(opts.forceSession) });
  });

auth
  .command("logout")
  .description("Clear credentials and stop running daemon")
  .option("--json", "JSON output")
  .action(async (opts: { json?: boolean }) => {
    await runAuthLogout(opts);
  });

auth
  .command("status")
  .description("Report whether a credential is stored (token is never printed)")
  .option("--json", "JSON output")
  .option("--no-user", "Skip the GitHub /user lookup that fetches the login name")
  .action(async (opts: { json?: boolean; user?: boolean }) => {
    let info: Awaited<ReturnType<typeof inspectStoredCredential>>;
    try {
      info = await inspectStoredCredential();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      if (opts.json) {
        process.stdout.write(JSON.stringify({ status: "error", error: message }, null, 2) + "\n");
      } else {
        process.stderr.write(`auth status error: ${message}\n`);
      }
      process.exit(1);
    }

    // commander's --no-user toggles opts.user to false; when the flag is
    // omitted opts.user is undefined and we treat that as "fetch by default".
    const userLookupEnabled = info.stored && opts.user !== false;
    let identity: null | GithubIdentitySummary = null;
    if (userLookupEnabled) {
      // inspectGithubIdentity is designed to return null on any failure, but
      // we wrap defensively at the CLI level too: a regression in the wrapper,
      // or a platform-specific fetch error path (e.g. Node 22 on macOS has
      // surfaced uncaught socket rejections from privileged-port ECONNREFUSED),
      // must never break the auth-status command. Status output should always
      // succeed even when the network is broken.
      try {
        identity = await inspectGithubIdentity();
      } catch {
        identity = null;
      }
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: info.stored ? "logged_in" : "logged_out",
            stored: info.stored,
            backend: info.backend,
            user: identity
          },
          null,
          2
        ) + "\n"
      );
    } else if (info.stored) {
      process.stdout.write(`${formatHumanAuthStatusLine(info.backend, identity)}\n`);
    } else {
      process.stdout.write("not logged in\n");
    }
    process.exit(info.stored ? 0 : 2);
  });

program
  .command("start")
  .description("Start proxy")
  .option("--detach", "Run in detached mode")
  .option("--debug", "Enable debug endpoints (e.g. /_debug)")
  .option("--no-codex", "Skip generating ~/.copillm/codex/ for Codex CLI")
  .option("--codex-model <id>", "Default Codex model slug")
  .option("--no-pi", "Skip generating ~/.pi/agent/models.json for pi coding agent")
  .option("--json", "JSON output")
  .action(async (opts: { detach?: boolean; debug?: boolean; codex?: boolean; codexModel?: string; pi?: boolean; json?: boolean }) => {
    const debug = resolveCopillmDebug(opts.debug);
    enableRuntimeDebug(debug);
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
        const codex = opts.codex === false ? null : await refreshCodexHome(existingLock.port, opts.codexModel ?? null);
        const pi = opts.pi === false ? null : await refreshPiHome(existingLock.port);
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

      const daemonArgs = [process.argv[1], "daemon"];
      if (debug) {
        daemonArgs.push("--debug");
      }
      const child = spawn(process.execPath, daemonArgs, {
        detached: true,
        stdio: "ignore",
        env: daemonSpawnEnv(debug)
      });
      child.unref();

      const started = await waitForDaemonReady(child.pid ?? null, 8_000);
      if (!started) {
        throw new Error("Detached daemon start timed out.");
      }

      const codex = opts.codex === false ? null : await refreshCodexHome(started.port, opts.codexModel ?? null);
      const pi = opts.pi === false ? null : await refreshPiHome(started.port);
      const claude = buildClaudeExportCommand(started.port, null);
      const banner = formatStartBanner({
        port: started.port,
        pid: started.pid,
        mode: "detached",
        debug,
        debugLogPath: currentDebugLogPath(debug),
        codex,
        pi
      });

      writeCommandOutput(opts, banner, {
        status: "ok",
        mode: "detached",
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
      });
      return;
    }

    // Foreground path: interactively prompt for login if needed.
    await ensureAuthenticatedInteractive();

    const started = await runDaemon({ debug });
    if (started.kind === "already_running") {
      const activeDebug = await warnIfDebugRequestedButInactive(debug, started.lock.port);
      const codex = opts.codex === false ? null : await refreshCodexHome(started.lock.port, opts.codexModel ?? null);
      const pi = opts.pi === false ? null : await refreshPiHome(started.lock.port);
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

    const codex = opts.codex === false ? null : await refreshCodexHome(started.port, opts.codexModel ?? null);
    const pi = opts.pi === false ? null : await refreshPiHome(started.port);
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
      logger.fatal({ err }, "daemon failed to start");
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
      pid: lockState.state === "running" ? lockState.lock.pid : null,
      port: lockState.state === "running" ? lockState.lock.port : null,
      started_at_iso: lockState.state === "running" ? lockState.lock.started_at_iso : null,
      uptime_seconds: uptimeSeconds,
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
        process.stdout.write(`uptime_seconds: ${status.uptime_seconds}\n`);
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

function writeAuthStatusLine(authInfo: { stored: boolean; backend: null | CredentialBackend; error: null | string }): void {
  if (authInfo.error) {
    process.stdout.write(`auth: error (${authInfo.error})\n`);
    return;
  }
  if (authInfo.stored) {
    process.stdout.write(`auth: logged in (${describeBackend(authInfo.backend)})\n`);
  } else {
    process.stdout.write("auth: not logged in\n");
  }
}

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

    const response = await fetch(`http://127.0.0.1:${lockState.lock.port}/healthz`, { signal: AbortSignal.timeout(2_000) });
    const payload = (await response.json()) as Record<string, unknown>;
    const output = { ok: response.ok, status_code: response.status, ...payload };
    writeHealthOutput(opts, output);
    if (!response.ok) {
      process.exitCode = 1;
    }
  });

const models = program.command("models").description("Model commands");

models
  .command("list")
  .description("List entitled models")
  .option("--json", "JSON output")
  .action(async (opts: { json?: boolean }) => {
    const config = loadConfig();
    const creds = await loadStoredCredential();
    if (!creds) {
      throw new Error("Not authenticated. Run `copillm login`.");
    }
    const tokenManager = new CopilotTokenManager(creds.token);
    await tokenManager.ensureToken(false);
    const result = await listModels(config.accountType, creds.token);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            models: result.models,
            discovery: {
              source: result.source,
              stale: result.stale,
              cache_age_seconds: result.cacheAgeSeconds,
              warning: result.warning
            }
          },
          null,
          2
        ) + "\n"
      );
      return;
    }
    process.stdout.write(result.models.map((model) => model.id).join("\n") + "\n");
    if (result.stale) {
      process.stdout.write("⚠ using stale model snapshot (upstream discovery unavailable)\n");
    }
  });

models
  .command("select")
  .requiredOption("--models <ids>", "Comma-separated model ids")
  .description("Select exposed models")
  .option("--json", "JSON output")
  .action(async (opts: { models: string; json?: boolean }) => {
    const config = loadConfig();
    const requested = Array.from(
      new Set(
        opts.models
      .split(",")
      .map((value) => value.trim())
          .filter((value) => value.length > 0)
      )
    );
    if (requested.length === 0) {
      throw new Error("At least one model must be selected.");
    }
    const creds = await loadStoredCredential();
    if (!creds) {
      throw new Error("Not authenticated. Run `copillm login`.");
    }
    const tokenManager = new CopilotTokenManager(creds.token);
    await tokenManager.ensureToken(false);
    const discovery = await listModels(config.accountType, creds.token);
    const resolution = resolveModelSelections(requested, discovery.models);
    if (resolution.unresolved.length > 0) {
      const available = discovery.models.map((model) => model.id).join(", ");
      throw new Error(
        `Unknown model selection(s): ${resolution.unresolved.join(", ")}. Available models: ${available}`
      );
    }
    const resolvedSelected = Array.from(new Set(resolution.resolved.map((entry) => entry.resolvedId)));
    saveConfig({ ...config, selectedModels: resolvedSelected });
    const usedAlias = resolution.resolved.some((entry) => entry.input !== entry.resolvedId);
    writeCommandOutput(
      opts,
      `Selected ${resolvedSelected.length} model(s)${usedAlias ? " (resolved aliases)." : "."}${
        discovery.stale ? " Using stale snapshot." : ""
      }`,
      {
      status: "ok",
      selected_models: resolvedSelected,
      requested_models: requested,
      resolutions: resolution.resolved,
      discovery: {
        source: discovery.source,
        stale: discovery.stale,
        cache_age_seconds: discovery.cacheAgeSeconds,
        warning: discovery.warning
      }
    }
    );
  });

program
  .command("env <agent>")
  .description("Print env vars to launch codex, claude, or pi against copillm")
  .option("--shell <shell>", "Shell syntax: sh|fish|powershell", "sh")
  .option("--json", "JSON output")
  .option("--inline", "Single-line legacy export form (claude only)")
  .action(async (agentRaw: string, opts: { shell: string; json?: boolean; inline?: boolean }) => {
    const agent = parseAgentName(agentRaw);
    if (!isShellSyntax(opts.shell)) {
      throw new Error(`Unsupported --shell value: ${opts.shell}. Use sh, fish, or powershell.`);
    }
    const shell: ShellSyntax = opts.shell;

    const lockState = inspectLock();
    if (lockState.state !== "running") {
      const message =
        lockState.state === "stale"
          ? `copillm has a stale lock (${lockState.reason}). Run \`copillm stop\` then \`copillm start --detach\`.`
          : "copillm is not running. Run `copillm start --detach` first.";
      if (opts.json) {
        process.stdout.write(JSON.stringify({ status: "not_running", agent, error: message }, null, 2) + "\n");
      } else {
        process.stderr.write(`${message}\n`);
      }
      process.exit(2);
      return;
    }

    if (agent === "codex") {
      const codex = await refreshCodexHome(lockState.lock.port, null);
      if (!codex) {
        throw new Error("Failed to prepare Codex home (see warning above).");
      }
      const bundle = buildCodexEnvBundle(codex.outDir);
      const block = renderEnvBlock({
        agent: "codex",
        env: bundle.env,
        shell,
        inlineComments: bundle.inlineComments,
        trailingNotes: bundle.trailingNotes
      });
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              agent: "codex",
              package: "@openai/codex",
              shell,
              env: bundle.env,
              shell_block: block
            },
            null,
            2
          ) + "\n"
        );
      } else {
        process.stdout.write(`${block}\n`);
      }
      process.exit(0);
    }

    if (agent === "pi") {
      const pi = await refreshPiHome(lockState.lock.port);
      if (!pi) {
        throw new Error("Failed to prepare pi models.json (see warning above).");
      }
      const bundle = buildPiEnvBundle(pi.outDir);
      const block = renderEnvBlock({
        agent: "pi",
        env: bundle.env,
        shell,
        inlineComments: bundle.inlineComments,
        trailingNotes: bundle.trailingNotes
      });
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              agent: "pi",
              package: "@earendil-works/pi-coding-agent",
              shell,
              env: bundle.env,
              shell_block: block,
              pi_home: pi.outDir,
              pi_config_path: pi.configPath,
              pi_mirror_path: pi.mirrorPath,
              pi_backup_path: pi.backupPath,
              pi_model_count: pi.modelCount
            },
            null,
            2
          ) + "\n"
        );
      } else {
        process.stdout.write(`${block}\n`);
      }
      process.exit(0);
    }

    const claude = buildClaudeExportCommand(lockState.lock.port, null);
    const settingsConflicts = detectClaudeSettingsConflicts(claude.bundle.env);
    if (opts.inline) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ agent: "claude", inline: claude.command }, null, 2) + "\n");
      } else {
        process.stdout.write(`${claude.command}\n`);
      }
      for (const line of formatSettingsConflictWarning(settingsConflicts)) {
        process.stderr.write(`${line}\n`);
      }
      process.exit(0);
    }
    const block = renderEnvBlock({
      agent: "claude",
      env: claude.bundle.env,
      shell,
      inlineComments: claude.bundle.inlineComments,
      trailingNotes: claude.bundle.trailingNotes
    });
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            agent: "claude",
            package: "@anthropic-ai/claude-code",
            shell,
            env: claude.bundle.env,
            shell_block: block,
            defaults: claude.defaults,
            settings_conflicts: settingsConflicts.conflicts
          },
          null,
          2
        ) + "\n"
      );
    } else {
      process.stdout.write(`${block}\n`);
    }
    for (const line of formatSettingsConflictWarning(settingsConflicts)) {
      process.stderr.write(`${line}\n`);
    }
    process.exit(0);
  });

program
  .command("codex")
  .description("Launch Codex CLI against copillm (auto-starts daemon, downloads codex if missing)")
  .option("--copillm-use <spec>", "Pin codex package version (e.g. 1.4.7 or @openai/codex@1.4.7)")
  .option("--copillm-debug", "Enable debug endpoints when auto-starting daemon")
  .option("--copillm-profile <name>", "Override active profile from ~/.copillm/agent.toml for this launch")
  .option("--copillm-no-config", "Skip agent.toml fan-out for this launch", false)
  .option("--yolo", "Skip approvals/sandbox (injects --dangerously-bypass-approvals-and-sandbox). Env: COPILLM_YOLO")
  .allowUnknownOption(true)
  .passThroughOptions()
  .helpOption(false)
  .argument("[args...]", "Args forwarded to codex")
  .action(
    async (
      forwardedArgs: string[],
      opts: { copillmUse?: string; copillmDebug?: boolean; copillmProfile?: string; copillmNoConfig?: boolean; yolo?: boolean }
    ) => {
      const debug = resolveCopillmDebug(opts.copillmDebug);
      enableRuntimeDebug(debug);
      const lock = await ensureDaemonRunningForLauncher({ debug });
      const codex = await refreshCodexHome(lock.port, null);
      if (!codex) {
        throw new Error("Failed to prepare Codex home (see warning above).");
      }
      const bundle = buildCodexEnvBundle(codex.outDir);
      const pinnedSpec = opts.copillmUse ?? process.env.COPILLM_CODEX_VERSION ?? undefined;
      const applyResult = applyAgentConfig({
        agent: "codex",
        cwd: process.cwd(),
        codexHomeDir: codex.outDir,
        profileOverride: opts.copillmProfile ?? process.env.COPILLM_PROFILE ?? null,
        skip: Boolean(opts.copillmNoConfig)
      });
      for (const line of formatApplyNotes(applyResult, "codex")) {
        process.stderr.write(`${line}\n`);
      }
      const env = { ...bundle.env, ...applyResult.envOverlay };
      const baseArgs = [...(forwardedArgs ?? []), ...applyResult.cliArgs];
      const args = applyYolo({ agent: "codex", userArgs: baseArgs, yolo: resolveYolo(opts.yolo) });
      const exitCode = await launchAgent({
        agent: "codex",
        args,
        env,
        pinnedSpec
      });
      process.exit(exitCode);
    }
  );

program
  .command("claude")
  .description("Launch Claude Code against copillm (auto-starts daemon, downloads claude if missing)")
  .option("--copillm-use <spec>", "Pin claude package version (e.g. 1.0.0 or @anthropic-ai/claude-code@1.0.0)")
  .option("--copillm-debug", "Enable debug endpoints when auto-starting daemon")
  .option("--copillm-profile <name>", "Override active profile from ~/.copillm/agent.toml for this launch")
  .option("--copillm-no-config", "Skip agent.toml fan-out for this launch", false)
  .option("--yolo", "Skip permission prompts (injects --dangerously-skip-permissions). Env: COPILLM_YOLO")
  .allowUnknownOption(true)
  .passThroughOptions()
  .helpOption(false)
  .argument("[args...]", "Args forwarded to claude")
  .action(
    async (
      forwardedArgs: string[],
      opts: { copillmUse?: string; copillmDebug?: boolean; copillmProfile?: string; copillmNoConfig?: boolean; yolo?: boolean }
    ) => {
      const debug = resolveCopillmDebug(opts.copillmDebug);
      enableRuntimeDebug(debug);
      const lock = await ensureDaemonRunningForLauncher({ debug });
      const claude = buildClaudeExportCommand(lock.port, null);
      const pinnedSpec = opts.copillmUse ?? process.env.COPILLM_CLAUDE_VERSION ?? undefined;
      const conflicts = detectClaudeSettingsConflicts(claude.bundle.env);
      for (const line of formatSettingsConflictWarning(conflicts)) {
        process.stderr.write(`${line}\n`);
      }
      const applyResult = applyAgentConfig({
        agent: "claude",
        cwd: process.cwd(),
        profileOverride: opts.copillmProfile ?? process.env.COPILLM_PROFILE ?? null,
        skip: Boolean(opts.copillmNoConfig)
      });
      for (const line of formatApplyNotes(applyResult, "claude")) {
        process.stderr.write(`${line}\n`);
      }
      const env = { ...claude.bundle.env, ...applyResult.envOverlay };
      const baseArgs = [...(forwardedArgs ?? []), ...applyResult.cliArgs];
      const args = applyYolo({ agent: "claude", userArgs: baseArgs, yolo: resolveYolo(opts.yolo) });
      const exitCode = await launchAgent({
        agent: "claude",
        args,
        env,
        pinnedSpec
      });
      process.exit(exitCode);
    }
  );

program
  .command("pi")
  .description("Launch pi coding agent against copillm (auto-starts daemon, downloads pi if missing)")
  .option("--copillm-use <spec>", "Pin pi package version (e.g. 0.75.4 or @earendil-works/pi-coding-agent@0.75.4)")
  .option("--copillm-debug", "Enable debug endpoints when auto-starting daemon")
  .option("--copillm-profile <name>", "Override active profile from ~/.copillm/agent.toml for this launch")
  .option("--copillm-no-config", "Skip agent.toml fan-out for this launch", false)
  .option("--yolo", "Skip approvals if supported (pi has no equivalent; emits a warning). Env: COPILLM_YOLO")
  .allowUnknownOption(true)
  .passThroughOptions()
  .helpOption(false)
  .argument("[args...]", "Args forwarded to pi")
  .action(
    async (
      forwardedArgs: string[],
      opts: { copillmUse?: string; copillmDebug?: boolean; copillmProfile?: string; copillmNoConfig?: boolean; yolo?: boolean }
    ) => {
      const debug = resolveCopillmDebug(opts.copillmDebug);
      enableRuntimeDebug(debug);
      const lock = await ensureDaemonRunningForLauncher({ debug });
      const pi = await refreshPiHome(lock.port);
      if (!pi) {
        throw new Error("Failed to prepare pi models.json (see warning above).");
      }
      const bundle = buildPiEnvBundle(pi.outDir);
      const pinnedSpec = opts.copillmUse ?? process.env.COPILLM_PI_VERSION ?? undefined;
      const applyResult = applyAgentConfig({
        agent: "pi",
        cwd: process.cwd(),
        profileOverride: opts.copillmProfile ?? process.env.COPILLM_PROFILE ?? null,
        skip: Boolean(opts.copillmNoConfig)
      });
      for (const line of formatApplyNotes(applyResult, "pi")) {
        process.stderr.write(`${line}\n`);
      }
      const env = { ...bundle.env, ...applyResult.envOverlay };
      const baseArgs = [...(forwardedArgs ?? []), ...applyResult.cliArgs];
      const args = applyYolo({ agent: "pi", userArgs: baseArgs, yolo: resolveYolo(opts.yolo) });
      const exitCode = await launchAgent({
        agent: "pi",
        args,
        env,
        pinnedSpec
      });
      process.exit(exitCode);
    }
  );

program
  .command("copilot")
  .description("Launch GitHub Copilot CLI reusing copillm's stored GitHub token (no second device flow)")
  .option("--copillm-use <spec>", "Pin copilot package version (e.g. 1.0.52 or @github/copilot@1.0.52)")
  .option("--copillm-profile <name>", "Override active profile from ~/.copillm/agent.toml for this launch")
  .option("--copillm-no-config", "Skip agent.toml fan-out for this launch", false)
  .option("--yolo", "Allow all tools/paths/URLs (injects --allow-all). Env: COPILLM_YOLO")
  .allowUnknownOption(true)
  .passThroughOptions()
  .helpOption(false)
  .argument("[args...]", "Args forwarded to copilot")
  .action(
    async (
      forwardedArgs: string[],
      opts: { copillmUse?: string; copillmProfile?: string; copillmNoConfig?: boolean; yolo?: boolean }
    ) => {
      const credential = await loadStoredCredential();
      if (!credential) {
        process.stderr.write(
          "copillm: no stored GitHub credential — run `copillm auth login` first.\n"
        );
        process.exit(1);
        return;
      }
      const pinnedSpec = opts.copillmUse ?? process.env.COPILLM_COPILOT_VERSION ?? undefined;
      const applyResult = applyAgentConfig({
        agent: "copilot",
        cwd: process.cwd(),
        profileOverride: opts.copillmProfile ?? process.env.COPILLM_PROFILE ?? null,
        skip: Boolean(opts.copillmNoConfig)
      });
      for (const line of formatApplyNotes(applyResult, "copilot")) {
        process.stderr.write(`${line}\n`);
      }
      // Inject the stored GitHub OAuth token into the child env only — never
      // export to the parent shell and never persist. Copilot CLI honours
      // COPILOT_GITHUB_TOKEN ahead of its own stored credentials, so this
      // short-circuits its device-flow login when copillm already has a token.
      const env: Record<string, string> = {
        ...applyResult.envOverlay,
        COPILOT_GITHUB_TOKEN: credential.token
      };
      const baseArgs = [...(forwardedArgs ?? []), ...applyResult.cliArgs];
      const args = applyYolo({ agent: "copilot", userArgs: baseArgs, yolo: resolveYolo(opts.yolo) });
      const exitCode = await launchAgent({
        agent: "copilot",
        args,
        env,
        pinnedSpec
      });
      process.exit(exitCode);
    }
  );

registerConfigCommands(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof Error) {
    logger.error({ err: error }, error.message);
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
});

async function runDaemon(options?: { debug?: boolean }): Promise<
  | { kind: "started"; port: number; callerSecret: null | string }
  | { kind: "already_running"; lock: LockFileData }
> {
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

function candidatePorts(preferredPort: number): number[] {
  const ports: number[] = [];
  for (let offset = 0; offset < 10; offset += 1) {
    const port = preferredPort + offset;
    if (port <= 65535) {
      ports.push(port);
    }
  }
  return ports;
}

function describeBackend(backend: null | CredentialBackend): string {
  switch (backend) {
    case "keyring":
      return "OS keychain";
    case "file":
      return "credentials file";
    case "session":
      return "in-memory (session only)";
    default:
      return "no backend";
  }
}

function formatHumanAuthStatusLine(
  backend: null | CredentialBackend,
  identity: null | GithubIdentitySummary
): string {
  if (!identity) {
    return `logged in (${describeBackend(backend)})`;
  }
  const nameSuffix = identity.name && identity.name !== identity.login ? ` (${identity.name})` : "";
  return `logged in as @${identity.login}${nameSuffix} (${describeBackend(backend)})`;
}

function emitDeprecation(opts: { json?: boolean }, oldCmd: string, newCmd: string): void {
  if (opts.json) {
    // Keep stdout pristine for JSON consumers; deprecation goes to stderr.
    process.stderr.write(`note: \`copillm ${oldCmd}\` is deprecated; use \`copillm ${newCmd}\`\n`);
  } else {
    process.stderr.write(`note: \`copillm ${oldCmd}\` is deprecated; use \`copillm ${newCmd}\`\n`);
  }
}

async function runAuthLogin(opts: { json?: boolean }, options: { forceSession: boolean }): Promise<void> {
  if (options.forceSession) {
    process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  }
  const config = loadConfig();
  const token = await loginViaDeviceFlow();
  const saveMode = options.forceSession ? "session" : "auto";
  const backend = await saveStoredCredential(token, config.accountType, { mode: saveMode });
  writeCommandOutput(opts, `Login succeeded. Credentials stored via ${describeBackend(backend)}.`, {
    status: "ok",
    action: "login",
    credential_backend: backend
  });
}

async function runAuthLogout(opts: { json?: boolean }): Promise<void> {
  const result = await clearStoredCredential();
  const lockState = inspectLock();
  if (lockState.state === "running") {
    await stopByPid(lockState.lock.pid);
  } else if (lockState.state === "stale") {
    releaseLock();
  }

  const credentialStatus = result.removed ? "removed" : "not present";
  writeCommandOutput(opts, `Logged out. Credentials ${credentialStatus} from ${describeBackend(result.backend)}.`, {
    status: "ok",
    action: "logout",
    credential_backend: result.backend,
    credential_removed: result.removed
  });
}

/**
 * Build the default dependency bundle for ensureAuthenticatedInteractive.
 * Lives here (rather than inside the auth module) so the auth module stays
 * UI-framework-agnostic and tests can supply alternative implementations.
 */
function defaultEnsureAuthDeps(): EnsureAuthenticatedDeps {
  return {
    inspectStoredCredential,
    isTty: () => process.stdin.isTTY === true,
    confirm,
    choose,
    loginViaDeviceFlow,
    loadAccountType: () => loadConfig().accountType,
    saveStoredCredential,
    describeBackend,
    print: (line) => process.stdout.write(line),
    setEnv: (key, value) => {
      process.env[key] = value;
    }
  };
}

async function ensureAuthenticatedInteractive(): Promise<void> {
  return ensureAuthenticatedInteractiveImpl(defaultEnsureAuthDeps());
}

function writeCommandOutput(opts: { json?: boolean }, humanLine: string, payload: Record<string, unknown>): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.stdout.write(`${humanLine}\n`);
}

function resolveCopillmDebug(commandDebug?: boolean): boolean {
  return Boolean(commandDebug) || Boolean(program.opts<{ debug?: boolean }>().debug);
}

function enableRuntimeDebug(debug: boolean): void {
  if (!debug) {
    return;
  }
  process.env.COPILLM_LOG_LEVEL = "debug";
  logger.level = "debug";
}

function currentDebugLogPath(debug: boolean): null | string {
  if (!debug) {
    return null;
  }
  return process.env.COPILLM_LOG_FILE ?? debugLogPath();
}

function daemonSpawnEnv(debug: boolean): NodeJS.ProcessEnv {
  if (!debug) {
    return process.env;
  }
  return {
    ...process.env,
    COPILLM_LOG_LEVEL: "debug",
    COPILLM_LOG_FILE: currentDebugLogPath(true) ?? debugLogPath()
  };
}

function formatStopHumanLine(
  primary: string,
  cache: { cleared: boolean; reason: null | string }
): string {
  if (cache.cleared) {
    return `${primary} Cleared Claude Code gateway cache.`;
  }
  if (cache.reason === "not_present") {
    return primary;
  }
  return `${primary} Could not clear Claude Code gateway cache: ${cache.reason ?? "unknown error"}.`;
}

function writeHealthOutput(opts: { json?: boolean }, payload: Record<string, unknown>): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function isAddrInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "EADDRINUSE";
}

async function refreshCodexHome(
  port: number,
  model: string | null
): Promise<null | Awaited<ReturnType<typeof generateCodexHome>>> {
  try {
    const home = getCopillmHome();
    return await generateCodexHome({
      outDir: defaultOutputDir(home),
      model,
      port,
      providerId: "copillm",
      reasoningEffort: null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`warning: failed to generate ~/.copillm/codex/ — ${message}\n`);
    return null;
  }
}

async function refreshPiHome(port: number): Promise<PiInitResult | null> {
  try {
    const home = getCopillmHome();
    return await generatePiHome({
      outDir: defaultPiOutputDir(home),
      port,
      providerId: "copillm"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`warning: failed to generate pi models.json — ${message}\n`);
    return null;
  }
}

function buildClaudeExportCommand(port: number, callerSecret: null | string): { command: string; defaults: AnthropicDefaults; bundle: ClaudeEnvBundle } {
  const modelIds = readModelIdsFromCache();
  const defaults = computeAnthropicDefaults(modelIds);
  const command = buildClaudeExport({
    port,
    callerSecret,
    defaults,
    enableGatewayDiscovery: true
  });
  const bundle = buildClaudeEnvBundle({ port, callerSecret, defaults, enableGatewayDiscovery: true });
  return { command, defaults, bundle };
}

function formatStartBanner(input: {
  port: number;
  pid: number;
  mode: "foreground" | "detached" | "already_running";
  debug: boolean;
  debugLogPath: null | string;
  codex: null | Awaited<ReturnType<typeof generateCodexHome>>;
  pi: PiInitResult | null;
}): string {
  const verb = input.mode === "foreground" ? "listening on" : "running on";
  const lines: string[] = [];
  const debugSuffix = input.debug ? " [debug]" : "";
  const modeSuffix = input.mode === "already_running" ? " (already running)" : "";
  lines.push(
    `\u25CF copillm ${verb} http://127.0.0.1:${input.port} (pid ${input.pid})${debugSuffix}${modeSuffix}`
  );
  if (input.codex) {
    lines.push(`   ${input.codex.modelCount} Copilot models discovered \u00B7 default: ${input.codex.defaultModel}`);
  }
  if (input.debugLogPath) {
    lines.push(`   debug log: ${displayHomePath(input.debugLogPath)}`);
  }
  if (input.pi) {
    lines.push(`   pi: wrote ${input.pi.modelCount} models to ${displayHomePath(input.pi.configPath)}${input.pi.backupPath ? ` (backed up prior config to ${displayHomePath(input.pi.backupPath)})` : ""}`);
  }
  lines.push(``);
  lines.push(`Launch an agent against copillm:`);
  if (input.codex) {
    lines.push(`    copillm codex      # starts Codex CLI, preconfigured`);
  }
  lines.push(`    copillm claude     # starts Claude Code, preconfigured`);
  if (input.pi) {
    lines.push(`    copillm pi         # starts pi coding agent, preconfigured`);
  }
  lines.push(``);
  lines.push(`Or print env vars to use yourself:`);
  if (input.codex) {
    lines.push(`    copillm env codex`);
  }
  lines.push(`    copillm env claude`);
  if (input.pi) {
    lines.push(`    copillm env pi`);
  }
  return lines.join("\n");
}

function displayHomePath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return p.replace(home, "~");
  }
  return p;
}

async function probeLivez(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/livez`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function warnIfDebugRequestedButInactive(debugRequested: boolean, port: number): Promise<boolean> {
  if (!debugRequested) {
    return false;
  }
  const active = await probeDebugEndpoint(port);
  if (!active) {
    process.stderr.write(
      `warning: copillm is already running without debug mode; run \`copillm stop\` then \`copillm --debug start --detach\` to enable daemon diagnostics.\n`
    );
  }
  return active;
}

async function probeDebugEndpoint(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_debug`, { signal: AbortSignal.timeout(1_200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function probeHealth(port: number): Promise<{
  ok: boolean;
  bearerTtlSeconds: null | number;
  statusCode: null | number;
  status: null | string;
  error: null | string;
}> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_500) });
    const payload = (await response.json()) as {
      bearer_ttl_seconds?: unknown;
      status?: unknown;
      error?: unknown;
    };
    return {
      ok: response.ok,
      statusCode: response.status,
      status: typeof payload.status === "string" ? payload.status : null,
      error: typeof payload.error === "string" ? payload.error : null,
      bearerTtlSeconds: response.ok && typeof payload.bearer_ttl_seconds === "number" ? payload.bearer_ttl_seconds : null
    };
  } catch {
    return { ok: false, bearerTtlSeconds: null, statusCode: null, status: null, error: "health_probe_failed" };
  }
}

async function waitForDaemonReady(pid: null | number, timeoutMs: number): Promise<null | { pid: number; port: number }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const lockState = inspectLock();
    if (lockState.state === "running" && (await probeLivez(lockState.lock.port))) {
      return { pid: lockState.lock.pid, port: lockState.lock.port };
    }
    if (pid !== null && !isPidAlive(pid)) {
      return null;
    }
    await sleep(150);
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopByPid(pid: number): Promise<void> {
  if (!sendSignalIfAlive(pid, "SIGTERM")) {
    return;
  }
  const stopDeadline = Date.now() + 8_000;
  while (Date.now() < stopDeadline) {
    const lockState = inspectLock();
    if (lockState.state !== "running" || lockState.lock.pid !== pid) {
      return;
    }
    await sleep(150);
  }

  if (!sendSignalIfAlive(pid, "SIGKILL")) {
    return;
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline) {
    const lockState = inspectLock();
    if (lockState.state !== "running" || lockState.lock.pid !== pid) {
      return;
    }
    await sleep(100);
  }

  throw new Error(`Failed to stop daemon pid ${pid}.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timeoutPromise = sleep(timeoutMs).then(() => {
    throw new Error(message);
  });
  return Promise.race([promise, timeoutPromise]);
}

function sendSignalIfAlive(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function readLiveLock(): Promise<null | LockFileData> {
  const lockState = inspectLock();
  if (lockState.state !== "running") {
    return null;
  }
  return (await probeLivez(lockState.lock.port)) ? lockState.lock : null;
}

function computeUptimeSeconds(startedAtIso: string): null | number {
  const startedMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startedMs)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
}

function parseAgentName(raw: string): AgentName {
  const v = raw.trim().toLowerCase();
  if (v === "codex" || v === "claude" || v === "pi") return v;
  throw new Error(`Unknown agent: ${raw}. Expected "codex", "claude", or "pi".`);
}

async function ensureDaemonRunningForLauncher(opts: { debug: boolean }): Promise<LockFileData> {
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
  const daemonArgs = [process.argv[1], "daemon"];
  if (opts.debug) daemonArgs.push("--debug");
  const child = spawn(process.execPath, daemonArgs, {
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
