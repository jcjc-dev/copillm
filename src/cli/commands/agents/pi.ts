import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { applyAgentConfig, formatApplyNotes } from "../../../agentconfig/apply.js";
import { loadAgentConfig, type LoadResult } from "../../../agentconfig/load.js";
import { CopilotTokenManager } from "../../../auth/copilotToken.js";
import { ensureSecureDirectory, writeFileSecureAtomic } from "../../../config/fsSecurity.js";
import { loadStoredCredential } from "../../../auth/credentials.js";
import { buildPiEnvBundle } from "../../agentEnv.js";
import { getCopillmHome, piAgentDir } from "../../../config/home.js";
import { copilotBaseUrl } from "../../../config/upstream.js";
import { discoverAndWritePiModels } from "../../../agentconfig/piModels.js";
import type { AccountType } from "../../../types/index.js";
import { processCopillmArgs } from "../../copillmFlags.js";
import { ensureDaemonRunningForLauncher } from "../../daemon/ensureRunning.js";
import { launchAgent } from "../../launchAgent.js";
import { refreshPiHome } from "../../integrations/refreshPi.js";
import { defaultOutputDir as defaultPiOutputDir } from "../../../integrations/pi/init.js";
import { isPiNativeCopilotEnabled } from "../../../integrations/pi/mode.js";
import { applyPiModelDefault, applyPiThinkingDefault } from "../../../agentconfig/piLaunch.js";
import { enableRuntimeDebug, resolveCopillmDebug } from "../../shared/debug.js";
import { applyYoloForLaunch, formatLaunchAccountNotice, resolveLaunchAccount } from "./shared.js";
import { resolveSessionScope, type SessionScopeResolution } from "../../../agentconfig/sessionScope.js";

export function register(program: Command): void {
  program
    .command("pi")
    .description("Launch pi coding agent with native Copilot by default (downloads pi if missing)")
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
        const nativeCopilot =
          opts.copillmCopilot === true || (isPiNativeCopilotEnabled() && !loaded?.resolved.provider);
        enableRuntimeDebug(debug);
        const mirrorDir = defaultPiOutputDir(
          getCopillmHome(),
          sessionScope.scope,
          sessionScope.profileName
        );
        let piMirrorDir = mirrorDir;
        // Native Copilot mode: feed the exchanged Copilot token to pi's built-in
        // GitHub Copilot provider via COPILOT_GITHUB_TOKEN, skipping the copillm
        // daemon entirely. pi's bundled github-copilot catalog points at the
        // legacy `api.individual.githubcopilot.com` host, so copillm writes a
        // minimal models.json that repoints that provider at the account-typed
        // host (same base-URL logic the daemon uses) without touching the rest
        // of the file or defining a custom provider.
        let copilotToken: null | string = null;
        if (nativeCopilot) {
          const ctx = await resolveNativeCopilotContext(launchAccount);
          copilotToken = ctx.token;
          writeNativeCopilotModels(
            piAgentDir(sessionScope.scope, sessionScope.profileName),
            ctx.accountType
          );
          process.stderr.write(
            "copillm: pi in native Copilot mode (COPILOT_GITHUB_TOKEN fed directly); daemon not started\n"
          );
        } else if (!loaded?.resolved.provider) {
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
        // Profile-scoped pi model providers: discover their /models endpoint and
        // merge into the pi agent dir's models.json. Enabled in native mode by
        // default; COPILLM_PI_NATIVE_COPILOT=0 retains the legacy proxy path.
        const piModels = nativeCopilot ? (loaded?.resolved.piModels ?? {}) : {};
        if (Object.keys(piModels).length > 0) {
          const agentDir = piAgentDir(sessionScope.scope, sessionScope.profileName);
          const piNotes = await discoverAndWritePiModels(agentDir, piModels);
          for (const note of piNotes) {
            process.stderr.write(`  • ${note}\n`);
          }
        }
        const env = {
          ...bundle.env,
          ...applyResult.envOverlay,
          ...(copilotToken ? { COPILOT_GITHUB_TOKEN: copilotToken } : {})
        };
        const baseArgs = [...forwarded, ...applyResult.cliArgs];
        const modelDefault = loaded?.resolved.provider ? undefined : loaded?.resolved.pi?.model;
        const args = applyYoloForLaunch({
          agent: "pi",
          flag: opts.yolo,
          applyResult,
          baseArgs: applyPiThinkingDefault(
            applyPiModelDefault(baseArgs, modelDefault),
            loaded?.resolved.pi?.thinking_level
          )
        });
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

/**
 * Resolve the exchanged Copilot token + account plan type for the launch
 * target. Named accounts load their own stored GitHub OAuth token; the default
 * account uses the legacy store. The account type selects the upstream base
 * URL pi should be pointed at.
 */
async function resolveNativeCopilotContext(launchAccount: {
  account?: { githubToken?: string; accountType?: AccountType };
} | null): Promise<{ token: string; accountType: AccountType }> {
  const named = launchAccount?.account;
  const fallback = named ? null : await loadStoredCredential();
  const githubToken = named?.githubToken ?? fallback?.token;
  if (!githubToken) {
    throw new Error(
      "No stored GitHub credential. Run `copillm auth login` (or `--copillm-account`) first."
    );
  }
  const accountType = named?.accountType ?? fallback?.accountType ?? "individual";
  const token = await new CopilotTokenManager(githubToken).ensureToken(false);
  return { token, accountType };
}

/**
 * Provider ids copillm's proxy writes into pi's models.json to enumerate the
 * local daemon endpoints. They must never surface when the Copilot token is
 * fed natively — pi should talk to Copilot directly, not through copillm's
 * proxy, so any stale entries are stripped before writing.
 */
const COPILLM_PROXY_PROVIDER_IDS = new Set(["copillm", "copillm-responses"]);

/**
 * Write a minimal models.json that repoints pi's built-in github-copilot
 * provider at the account-typed Copilot host. pi's bundled catalog hardcodes
 * `api.individual.githubcopilot.com`, which rejects current Copilot tokens
 * (401); `api.githubcopilot.com` / `api.business.*` / `api.enterprise.*`
 * accept them. Stale copillm proxy providers (the model-enumerating daemon
 * endpoints) are stripped so they never appear when the token is fed natively;
 * unrelated providers (e.g. pi_models) and the token itself (via
 * COPILOT_GITHUB_TOKEN) are left untouched.
 */
function writeNativeCopilotModels(agentDir: string, accountType: AccountType): void {
  ensureSecureDirectory(agentDir);
  const modelsPath = path.join(agentDir, "models.json");
  let doc: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or corrupt file — start fresh.
  }
  const providers =
    doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers)
      ? (doc.providers as Record<string, unknown>)
      : {};
  for (const id of COPILLM_PROXY_PROVIDER_IDS) {
    delete providers[id];
  }
  const copilot =
    providers["github-copilot"] && typeof providers["github-copilot"] === "object"
      ? { ...(providers["github-copilot"] as Record<string, unknown>) }
      : {};
  copilot.baseUrl = copilotBaseUrl(accountType);
  providers["github-copilot"] = copilot;
  doc.providers = providers;
  writeFileSecureAtomic(modelsPath, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
}
