import type { Command } from "commander";
import { applyAgentConfig, formatApplyNotes } from "../../../agentconfig/apply.js";
import { loadStoredCredential } from "../../../auth/credentials.js";
import { processCopillmArgs } from "../../copillmFlags.js";
import { launchAgent } from "../../launchAgent.js";
import { applyYoloForLaunch } from "./shared.js";

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
