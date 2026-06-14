import { getCopillmHome } from "../../config/home.js";
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
  opts?: { pathPrefix?: string; account?: AccountDiscoveryOverride }
): Promise<null | Awaited<ReturnType<typeof generateCodexHome>>> {
  try {
    const home = getCopillmHome();
    return await generateCodexHome({
      outDir: defaultOutputDir(home),
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
    process.stderr.write(`warning: failed to generate ~/.copillm/codex/ — ${message}\n`);
    return null;
  }
}
