import type { Command } from "commander";
import path from "node:path";
import { applyAgentConfig, formatApplyNotes } from "../../agentconfig/apply.js";
import { loadAgentConfig } from "../../agentconfig/load.js";
import { resolveSessionScope } from "../../agentconfig/sessionScope.js";
import { codexHomeDir, getCopillmHome, piAgentDir } from "../../config/home.js";
import {
  claudeSettingsPath,
  detectClaudeSettingsConflicts,
  formatSettingsConflictWarning
} from "../../integrations/claude/settingsConflict.js";
import { defaultOutputDir as defaultPiOutputDir, piModelsJsonPath } from "../../integrations/pi/init.js";
import { inspectLock } from "../../server/lock.js";
import { buildCodexEnvBundle, buildCopilotEnvOverlay, buildPiEnvBundle } from "../agentEnv.js";
import { isShellSyntax, renderEnvBlock, type ShellSyntax } from "../envBlock.js";
import { buildClaudeExportCommand } from "../integrations/claudeExport.js";
import { refreshCodexHome } from "../integrations/refreshCodex.js";
import { refreshPiHome } from "../integrations/refreshPi.js";
import { parseAgentName } from "../shared/parseAgent.js";

export function register(program: Command): void {
  program
    .command("env <agent>")
    .description("Print env vars to launch codex, claude, pi, or copilot")
    .option("--shell <shell>", "Shell syntax: sh|fish|powershell", "sh")
    .option("--json", "JSON output")
    .option("--inline", "Single-line legacy export form (claude only)")
    .option("--profile <name>", "Override the active profile for this output")
    .option("--copillm-profile <name>", "Alias for --profile")
    .action(async (
      agentRaw: string,
      opts: { shell: string; json?: boolean; inline?: boolean; profile?: string; copillmProfile?: string }
    ) => {
      const agent = parseAgentName(agentRaw);
      if (!isShellSyntax(opts.shell)) {
        throw new Error(`Unsupported --shell value: ${opts.shell}. Use sh, fish, or powershell.`);
      }
      const shell: ShellSyntax = opts.shell;
      const profileOverride = opts.profile ?? opts.copillmProfile ?? process.env.COPILLM_PROFILE ?? null;
      const loaded = loadAgentConfig({ cwd: process.cwd(), profileOverride });
      const externalProvider =
        agent === "codex" || agent === "pi" || agent === "copilot"
          ? loaded?.resolved.provider ?? null
          : null;

      if (agent === "copilot" && !externalProvider) {
        throw new Error(
          "`copillm env copilot` requires an external provider in the active agent.toml profile."
        );
      }

      const lockState = inspectLock();
      if (lockState.state !== "running" && !externalProvider) {
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
      const daemonPort = (): number => {
        if (lockState.state !== "running") {
          throw new Error("copillm is not running.");
        }
        return lockState.lock.port;
      };

      if (agent === "codex") {
        const sessionScope = resolveSessionScope({ cwd: process.cwd(), profileOverride });
        let codexHome: string;
        let codex: Awaited<ReturnType<typeof refreshCodexHome>> = null;
        if (externalProvider) {
          codexHome = codexHomeDir(sessionScope.scope, sessionScope.profileName);
          const applied = applyAgentConfig({
            agent: "codex",
            cwd: process.cwd(),
            profileOverride,
            loaded,
            codexHomeDir: codexHome
          });
          for (const line of formatApplyNotes(applied, "codex")) {
            process.stderr.write(`${line}\n`);
          }
        } else {
          codex = await refreshCodexHome(daemonPort(), null, undefined, {
            sessionScope: sessionScope.scope,
            profileName: sessionScope.profileName
          });
          if (!codex) {
            throw new Error("Failed to prepare Codex home (see warning above).");
          }
          codexHome = codex.outDir;
        }
        const bundle = buildCodexEnvBundle(codexHome);
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
                shell_block: block,
                provider: externalProvider?.id ?? null,
                codex_home: codexHome
              },
              null,
              2
            ) + "\n"
          );
        } else {
          process.stdout.write(`${block}\n`);
        }
        return;
      }

      if (agent === "pi") {
        const sessionScope = resolveSessionScope({ cwd: process.cwd(), profileOverride });
        let pi: Awaited<ReturnType<typeof refreshPiHome>> = null;
        let piMirrorDir: string;
        if (externalProvider) {
          piMirrorDir = defaultPiOutputDir(
            getCopillmHome(),
            sessionScope.scope,
            sessionScope.profileName
          );
          const applied = applyAgentConfig({
            agent: "pi",
            cwd: process.cwd(),
            profileOverride,
            loaded
          });
          for (const line of formatApplyNotes(applied, "pi")) {
            process.stderr.write(`${line}\n`);
          }
        } else {
          pi = await refreshPiHome(daemonPort(), undefined, {
            sessionScope: sessionScope.scope,
            profileName: sessionScope.profileName
          });
          if (!pi) {
            throw new Error("Failed to prepare pi models.json (see warning above).");
          }
          piMirrorDir = pi.outDir;
        }
        const bundle = buildPiEnvBundle(piMirrorDir, sessionScope.scope, sessionScope.profileName);
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
                provider: externalProvider?.id ?? null,
                pi_home: piMirrorDir,
                pi_config_path:
                  pi?.configPath ?? piModelsJsonPath(sessionScope.scope, sessionScope.profileName),
                pi_mirror_path: pi?.mirrorPath ?? path.join(piMirrorDir, "models.json"),
                pi_backup_path: pi?.backupPath ?? null,
                pi_model_count: pi?.modelCount ?? 1
              },
              null,
              2
            ) + "\n"
          );
        } else {
          process.stdout.write(`${block}\n`);
        }
        return;
      }

      if (agent === "copilot") {
        if (!externalProvider || !loaded) {
          throw new Error(
            "`copillm env copilot` requires an external provider in the active agent.toml profile."
          );
        }
        const sessionScope = resolveSessionScope({ cwd: process.cwd(), profileOverride });
        const applied = applyAgentConfig({
          agent: "copilot",
          cwd: process.cwd(),
          profileOverride,
          loaded
        });
        for (const line of formatApplyNotes(applied, "copilot")) {
          process.stderr.write(`${line}\n`);
        }

        const env: Record<string, string> = {
          ...buildCopilotEnvOverlay(sessionScope.scope, sessionScope.profileName),
          ...applied.envOverlay
        };
        const envReferences: Record<string, string> = {};
        const keyEnv =
          externalProvider.copilot.api_key_env ??
          externalProvider.api_key_env;
        if (keyEnv) {
          delete env.COPILOT_PROVIDER_API_KEY;
          env.COPILOT_PROVIDER_API_KEY = "";
          envReferences.COPILOT_PROVIDER_API_KEY = keyEnv;
        }
        const trailingNotes = [
          `copillm resolves provider "${externalProvider.id}" from the active profile.`
        ];
        if (keyEnv) {
          trailingNotes.push(
            "The API credential is read from the referenced environment variable at shell runtime."
          );
        }
        const block = renderEnvBlock({
          agent: "copilot",
          env,
          envReferences,
          shell,
          trailingNotes
        });
        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                agent: "copilot",
                package: "@github/copilot",
                shell,
                env,
                env_references: envReferences,
                shell_block: block,
                provider: externalProvider.id
              },
              null,
              2
            ) + "\n"
          );
        } else {
          process.stdout.write(`${block}\n`);
        }
        return;
      }

      const sessionScope = resolveSessionScope({ cwd: process.cwd(), profileOverride });
      const claude = buildClaudeExportCommand(daemonPort(), null, {
        sessionScope: sessionScope.scope,
        profileName: sessionScope.profileName
      });
      const settingsConflicts = detectClaudeSettingsConflicts(
        claude.bundle.env,
        claudeSettingsPath(sessionScope.scope, sessionScope.profileName)
      );
      if (opts.inline) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ agent: "claude", inline: claude.command }, null, 2) + "\n");
        } else {
          process.stdout.write(`${claude.command}\n`);
        }
        for (const line of formatSettingsConflictWarning(settingsConflicts)) {
          process.stderr.write(`${line}\n`);
        }
        return;
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
      return;
    });
}
