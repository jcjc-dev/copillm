import type { Command } from "commander";
import { applyAgentConfig, formatApplyNotes } from "../../../agentconfig/apply.js";
import { loadStoredCredential } from "../../../auth/credentials.js";
import { processCopillmArgs } from "../../copillmFlags.js";
import { launchAgent } from "../../launchAgent.js";
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
        // Copilot CLI talks to GitHub directly with the account's OAuth token,
        // so account selection picks which token to inject (not a URL prefix).
        const githubToken = launchAccount
          ? launchAccount.account.githubToken
          : (await loadStoredCredential())?.token ?? null;
        if (!githubToken) {
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
          COPILOT_GITHUB_TOKEN: githubToken
        };
        const baseArgs = [...forwarded, ...applyResult.cliArgs];
        const args = applyYoloForLaunch({ agent: "copilot", flag: opts.yolo, applyResult, baseArgs });
        const exitCode = await launchAgent({
          agent: "copilot",
          args,
          env,
          pinnedSpec
        });
        process.exit(exitCode);
      }
    );
}
