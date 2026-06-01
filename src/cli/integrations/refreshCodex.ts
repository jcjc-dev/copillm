import { getCopillmHome } from "../../config/home.js";
import { defaultOutputDir, generateCodexHome } from "../../integrations/codex/init.js";

export async function refreshCodexHome(
  port: number,
  model: string | null
): Promise<null | Awaited<ReturnType<typeof generateCodexHome>>> {
  try {
    const home = getCopillmHome();
    return await generateCodexHome({
      outDir: defaultOutputDir(home),
      model,
      port,
      providerId: "copillm",
      reasoningEffort: null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`warning: failed to generate ~/.copillm/codex/ — ${message}\n`);
    return null;
  }
}
