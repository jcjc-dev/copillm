import type { Command } from "commander";
import { detectClaudeSettingsConflicts, formatSettingsConflictWarning } from "../../integrations/claude/settingsConflict.js";
import { inspectLock } from "../../server/lock.js";
import { buildCodexEnvBundle, buildPiEnvBundle } from "../agentEnv.js";
import { isShellSyntax, renderEnvBlock, type ShellSyntax } from "../envBlock.js";
import { buildClaudeExportCommand } from "../integrations/claudeExport.js";
import { refreshCodexHome } from "../integrations/refreshCodex.js";
import { refreshPiHome } from "../integrations/refreshPi.js";
import { parseAgentName } from "../shared/parseAgent.js";

export function register(program: Command): void {
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
}
