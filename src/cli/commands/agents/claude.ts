import type { Command } from "commander";
import { applyAgentConfig, formatApplyNotes } from "../../../agentconfig/apply.js";
import { detectClaudeSettingsConflicts, formatSettingsConflictWarning } from "../../../integrations/claude/settingsConflict.js";
import { processCopillmArgs } from "../../copillmFlags.js";
import { ensureDaemonRunningForLauncher } from "../../daemon/ensureRunning.js";
import { launchAgent } from "../../launchAgent.js";
import { buildClaudeExportCommand } from "../../integrations/claudeExport.js";
import { enableRuntimeDebug, resolveCopillmDebug } from "../../shared/debug.js";
import { applyYoloForLaunch } from "./shared.js";

export function register(program: Command): void {
  program
    .command("claude")
    .description("Launch Claude Code against copillm (auto-starts daemon, downloads claude if missing)")
    .allowUnknownOption(true)
    .helpOption(false)
    .argument("[args...]", "Args forwarded to claude")
    .action(
      async (forwardedArgs: string[]) => {
        const { opts, forwarded } = processCopillmArgs(forwardedArgs ?? []);
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
        const baseArgs = [...forwarded, ...applyResult.cliArgs];
        const args = applyYoloForLaunch({ agent: "claude", flag: opts.yolo, applyResult, baseArgs });
        const exitCode = await launchAgent({
          agent: "claude",
          args,
          env,
          pinnedSpec
        });
        process.exit(exitCode);
      }
    );
}
