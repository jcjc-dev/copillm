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
import { applyDevModeEnv } from "./shared/devMode.js";
import { getPackageInfo } from "./packageInfo.js";
import { maybeNotifyAboutUpdate } from "./updateNotifier.js";

const logger = createLogger();
const program = new Command();
setRootProgram(program);
setRootLogger(logger);

// Honor COPILLM_DEV before anything reads COPILLM_HOME (e.g. the update
// notifier). The `--dev` flag form is applied later, in the preAction hook,
// once commander has parsed global options.
applyDevModeEnv();

const pkg = getPackageInfo();
await maybeNotifyAboutUpdate({ packageInfo: pkg });

program.name("copillm").description("Local Copilot proxy").version(pkg.version);
program.enablePositionalOptions();
program.option("--debug", "Enable copillm debug mode (debug endpoint plus verbose daemon diagnostics)");
program.option(
  "--dev",
  "Run against an isolated dev home (COPILLM_HOME=~/.copillm-dev, port 4142) so the dev daemon never conflicts with a production copillm"
);
program.option("--no-update-notifier", "Skip the npm registry update check for this run");

// Apply the `--dev` flag as soon as global options are parsed and before any
// subcommand action resolves COPILLM_HOME. Idempotent with the env-based call
// above.
program.hook("preAction", () => {
  applyDevModeEnv(Boolean(program.opts<{ dev?: boolean }>().dev));
});

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
