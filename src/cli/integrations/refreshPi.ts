import { getCopillmHome } from "../../config/home.js";
import { type AccountDiscoveryOverride, type PrecomputedStartContext } from "../../integrations/codex/init.js";
import {
  defaultOutputDir as defaultPiOutputDir,
  generatePiHome,
  type PiInitResult
} from "../../integrations/pi/init.js";

export async function refreshPiHome(
  port: number,
  precomputed?: PrecomputedStartContext,
  opts?: { pathPrefix?: string; account?: AccountDiscoveryOverride }
): Promise<PiInitResult | null> {
  try {
    const home = getCopillmHome();
    return await generatePiHome({
      outDir: defaultPiOutputDir(home),
      port,
      providerId: "copillm",
      precomputed,
      pathPrefix: opts?.pathPrefix,
      account: opts?.account
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`warning: failed to generate pi models.json — ${message}\n`);
    return null;
  }
}
