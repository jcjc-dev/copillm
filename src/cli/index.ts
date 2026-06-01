import { createRequire } from "node:module";
import { Command } from "commander";
import { createLogger } from "../config/logging.js";
import { registerConfigCommands } from "./configCommands.js";
import * as authCmd from "./commands/auth.js";
import * as daemonCmd from "./commands/daemon.js";
import * as modelsCmd from "./commands/models.js";
import * as envCmd from "./commands/env.js";
import * as codexCmd from "./commands/agents/codex.js";
import * as claudeCmd from "./commands/agents/claude.js";
import * as piCmd from "./commands/agents/pi.js";
import * as copilotCmd from "./commands/agents/copilot.js";
import { setRootLogger, setRootProgram } from "./shared/debug.js";

const logger = createLogger();
const program = new Command();
setRootProgram(program);
setRootLogger(logger);

// Resolve the package version from package.json at runtime so `--version` stays
// in sync with whatever was published. Using createRequire keeps this working
// under NodeNext ESM without needing an import-assertion syntax flag, and
// resolves the same file in both `dist/cli.js` (one level deep) and `src/cli.ts`
// when invoked via tsx.
const pkgVersion = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

program.name("copillm").description("Local Copilot proxy").version(pkgVersion);
program.enablePositionalOptions();
program.option("--debug", "Enable copillm debug mode (debug endpoint plus verbose daemon diagnostics)");

authCmd.register(program);
daemonCmd.register(program);
modelsCmd.register(program);
envCmd.register(program);
codexCmd.register(program);
claudeCmd.register(program);
piCmd.register(program);
copilotCmd.register(program);
registerConfigCommands(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof Error) {
    logger.error({ err: error }, error.message);
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
});
