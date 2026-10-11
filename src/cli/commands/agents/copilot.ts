import type { Command } from "commander";
import { applyAgentConfig, formatApplyNotes } from "../../../agentconfig/apply.js";
import { loadAgentConfig, type LoadResult } from "../../../agentconfig/load.js";
import { resolveSessionScope, type SessionScopeResolution } from "../../../agentconfig/sessionScope.js";
import { loadStoredCredential } from "../../../auth/credentials.js";
import { processCopillmArgs } from "../../copillmFlags.js";
import { launchAgent } from "../../launchAgent.js";
import { buildCopilotEnvOverlay } from "../../agentEnv.js";
import { applyYoloForLaunch, formatLaunchAccountNotice, resolveLaunchAccount } from "./shared.js";

export function register(program: Command): void {
  program
    .command("copilot")
    .description("Launch GitHub Copilot CLI reusing copillm's stored GitHub token (no second device flow)")
    .allowUnknownOption(true)
    .helpOption(false)
    .argument("[args...]", "Args forwarded to copilot")
    .action(
      async (forwardedArgs: string[]) => {
        const { opts, forwarded } = processCopillmArgs(forwardedArgs ?? []);
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
        // Copilot CLI talks to GitHub directly by default. External providers
        // use the provider-specific BYOK environment overlay instead.
        const githubToken = loaded?.resolved.provider
          ? null
          : launchAccount
            ? launchAccount.account.githubToken
            : (await loadStoredCredential())?.token ?? null;
        if (!loaded?.resolved.provider && !githubToken) {
          process.stderr.write(
            "copillm: no stored GitHub credential — run `copillm auth login` first.\n"
          );
          process.exit(1);
          return;
        }
        const pinnedSpec = opts.copillmUse ?? process.env.COPILLM_COPILOT_VERSION ?? undefined;
        const pinnedSource: "cli" | "env" | undefined = opts.copillmUse
          ? "cli"
          : process.env.COPILLM_COPILOT_VERSION
            ? "env"
            : undefined;
        const applyResult = applyAgentConfig({
          agent: "copilot",
          cwd: process.cwd(),
          profileOverride,
          loaded,
          skip: Boolean(opts.copillmNoConfig)
        });
        for (const line of formatApplyNotes(applyResult, "copilot")) {
          process.stderr.write(`${line}\n`);
        }
        const env: Record<string, string> = {
          ...buildCopilotEnvOverlay(sessionScope.scope, sessionScope.profileName),
          ...applyResult.envOverlay
        };
        if (githubToken) {
          // Inject the stored GitHub OAuth token into the child env only —
          // never export to the parent shell and never persist.
          env.COPILOT_GITHUB_TOKEN = githubToken;
        }
        const baseArgs = [...forwarded, ...applyResult.cliArgs];
        const args = applyYoloForLaunch({ agent: "copilot", flag: opts.yolo, applyResult, baseArgs });
        const exitCode = await launchAgent({
          agent: "copilot",
          args,
          env,
          pinnedSpec,
          pinnedSource
        });
        process.exit(exitCode);
      }
    );
}
