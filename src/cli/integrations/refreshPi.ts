import { getCopillmHome } from "../../config/home.js";
import {
  defaultOutputDir as defaultPiOutputDir,
  generatePiHome,
  type PiInitResult
} from "../../integrations/pi/init.js";

export async function refreshPiHome(port: number): Promise<PiInitResult | null> {
  try {
    const home = getCopillmHome();
    return await generatePiHome({
      outDir: defaultPiOutputDir(home),
      port,
      providerId: "copillm"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`warning: failed to generate pi models.json — ${message}\n`);
    return null;
  }
}
