import { codexHomeDir, getCopillmHome, type AgentSessionScope } from "../../config/home.js";
import {
  defaultOutputDir,
  generateCodexHome,
  type AccountDiscoveryOverride,
  type PrecomputedStartContext
} from "../../integrations/codex/init.js";

export async function refreshCodexHome(
  port: number,
  model: string | null,
  precomputed?: PrecomputedStartContext,
  opts?: {
    pathPrefix?: string;
    account?: AccountDiscoveryOverride;
    sessionScope?: AgentSessionScope;
    profileName?: string | null;
  }
): Promise<null | Awaited<ReturnType<typeof generateCodexHome>>> {
  try {
    const home = getCopillmHome();
    const outDir =
      opts?.sessionScope !== undefined || opts?.profileName !== undefined
        ? codexHomeDir(opts?.sessionScope ?? "shared", opts?.profileName)
        : defaultOutputDir(home);
    return await generateCodexHome({
      outDir,
      model,
      port,
      providerId: "copillm",
      reasoningEffort: null,
      precomputed,
      pathPrefix: opts?.pathPrefix,
      account: opts?.account
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`warning: failed to generate Codex home — ${message}\n`);
    return null;
  }
}
