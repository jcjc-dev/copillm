import type { Command } from "commander";
import { applyAgentConfig, formatApplyNotes } from "../../../agentconfig/apply.js";
import { buildCodexEnvBundle } from "../../agentEnv.js";
import { processCopillmArgs } from "../../copillmFlags.js";
import { ensureDaemonRunningForLauncher } from "../../daemon/ensureRunning.js";
import { launchAgent } from "../../launchAgent.js";
import { refreshCodexHome } from "../../integrations/refreshCodex.js";
import { enableRuntimeDebug, resolveCopillmDebug } from "../../shared/debug.js";
import { applyYoloForLaunch, formatLaunchAccountNotice, resolveLaunchAccount } from "./shared.js";

export function register(program: Command): void {
  program
    .command("codex")
    .description("Launch Codex CLI against copillm (auto-starts daemon, downloads codex if missing)")
    .allowUnknownOption(true)
    .helpOption(false)
    .argument("[args...]", "Args forwarded to codex")
    .action(
      async (forwardedArgs: string[]) => {
        const { opts, forwarded } = processCopillmArgs(forwardedArgs ?? []);
        const debug = resolveCopillmDebug(opts.copillmDebug);
        let launchAccount;
        try {
          launchAccount = await resolveLaunchAccount({
            flag: opts.copillmAccount,
            envValue: process.env.COPILLM_ACCOUNT,
            cwd: process.cwd(),
            profileOverride: opts.copillmProfile ?? process.env.COPILLM_PROFILE ?? null
          });
        } catch (error) {
          process.stderr.write(`copillm: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
          return;
        }
        if (launchAccount) {
          process.stderr.write(`${formatLaunchAccountNotice(launchAccount)}\n`);
        }
        enableRuntimeDebug(debug);
        const lock = await ensureDaemonRunningForLauncher({ debug });
        const codex = await refreshCodexHome(lock.port, null, undefined, {
          pathPrefix: launchAccount?.pathPrefix,
          account: launchAccount?.account
        });
        if (!codex) {
          throw new Error("Failed to prepare Codex home (see warning above).");
        }
        const bundle = buildCodexEnvBundle(codex.outDir);
        const pinnedSpec = opts.copillmUse ?? process.env.COPILLM_CODEX_VERSION ?? undefined;
        const pinnedSource: "cli" | "env" | undefined = opts.copillmUse
          ? "cli"
          : process.env.COPILLM_CODEX_VERSION
            ? "env"
            : undefined;
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
        const baseArgs = [...forwarded, ...applyResult.cliArgs];
        const args = applyYoloForLaunch({ agent: "codex", flag: opts.yolo, applyResult, baseArgs });
        const exitCode = await launchAgent({
          agent: "codex",
          args,
          env,
          pinnedSpec,
          pinnedSource
        });
        process.exit(exitCode);
      }
    );
}
