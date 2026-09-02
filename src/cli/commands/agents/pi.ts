import type { Command } from "commander";
import { applyAgentConfig, formatApplyNotes } from "../../../agentconfig/apply.js";
import { loadAgentConfig, type LoadResult } from "../../../agentconfig/load.js";
import { buildPiEnvBundle } from "../../agentEnv.js";
import { getCopillmHome } from "../../../config/home.js";
import { processCopillmArgs } from "../../copillmFlags.js";
import { ensureDaemonRunningForLauncher } from "../../daemon/ensureRunning.js";
import { launchAgent } from "../../launchAgent.js";
import { refreshPiHome } from "../../integrations/refreshPi.js";
import { defaultOutputDir as defaultPiOutputDir } from "../../../integrations/pi/init.js";
import { enableRuntimeDebug, resolveCopillmDebug } from "../../shared/debug.js";
import { applyYoloForLaunch, formatLaunchAccountNotice, resolveLaunchAccount } from "./shared.js";
import { resolveSessionScope, type SessionScopeResolution } from "../../../agentconfig/sessionScope.js";

export function register(program: Command): void {
  program
    .command("pi")
    .description("Launch pi coding agent against copillm (auto-starts daemon, downloads pi if missing)")
    .allowUnknownOption(true)
    .helpOption(false)
    .argument("[args...]", "Args forwarded to pi")
    .action(
      async (forwardedArgs: string[]) => {
        const { opts, forwarded } = processCopillmArgs(forwardedArgs ?? []);
        const debug = resolveCopillmDebug(opts.copillmDebug);
        const profileOverride = opts.copillmProfile ?? process.env.COPILLM_PROFILE ?? null;
        let sessionScope: SessionScopeResolution;
        let launchAccount;
        let loaded: LoadResult | null;
        try {
          loaded = opts.copillmNoConfig
            ? null
            : loadAgentConfig({ cwd: process.cwd(), profileOverride });
          sessionScope = resolveSessionScope({ cwd: process.cwd(), profileOverride });
          launchAccount = loaded?.resolved.provider
            ? null
            : await resolveLaunchAccount({
                flag: opts.copillmAccount,
                envValue: process.env.COPILLM_ACCOUNT,
                cwd: process.cwd(),
                profileOverride
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
        const mirrorDir = defaultPiOutputDir(
          getCopillmHome(),
          sessionScope.scope,
          sessionScope.profileName
        );
        let piMirrorDir = mirrorDir;
        if (!loaded?.resolved.provider) {
          const lock = await ensureDaemonRunningForLauncher({ debug });
          const pi = await refreshPiHome(lock.port, undefined, {
            pathPrefix: launchAccount?.pathPrefix,
            account: launchAccount?.account,
            sessionScope: sessionScope.scope,
            profileName: sessionScope.profileName
          });
          if (!pi) {
            throw new Error("Failed to prepare pi models.json (see warning above).");
          }
          piMirrorDir = pi.outDir;
        }
        const bundle = buildPiEnvBundle(piMirrorDir, sessionScope.scope, sessionScope.profileName);
        const pinnedSpec = opts.copillmUse ?? process.env.COPILLM_PI_VERSION ?? undefined;
        const pinnedSource: "cli" | "env" | undefined = opts.copillmUse
          ? "cli"
          : process.env.COPILLM_PI_VERSION
            ? "env"
            : undefined;
        const applyResult = applyAgentConfig({
          agent: "pi",
          cwd: process.cwd(),
          profileOverride,
          loaded,
          skip: Boolean(opts.copillmNoConfig)
        });
        for (const line of formatApplyNotes(applyResult, "pi")) {
          process.stderr.write(`${line}\n`);
        }
        const env = { ...bundle.env, ...applyResult.envOverlay };
        const baseArgs = [...forwarded, ...applyResult.cliArgs];
        const args = applyYoloForLaunch({ agent: "pi", flag: opts.yolo, applyResult, baseArgs });
        const exitCode = await launchAgent({
          agent: "pi",
          args,
          env,
          pinnedSpec,
          pinnedSource
        });
        process.exit(exitCode);
      }
    );
}
