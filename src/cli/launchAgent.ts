import { resolveAgent, type PinSource } from "./resolveAgent.js";
import { spawnAgent } from "./windowsSpawn.js";
import { type AgentName } from "../integrations/registry.js";

export interface LaunchOptions {
  agent: AgentName;
  args: string[];
  env: Record<string, string>;
  pinnedSpec?: string;
  /**
   * Where the pin came from. `env` for COPILLM_*_VERSION values; `cli` for
   * an explicit --copillm-use. Validates more strictly under "env" — an
   * env-supplied pin must be a bare version string, never a `<pkg>@<ver>`.
   */
  pinnedSource?: PinSource;
  log?: (line: string) => void;
}

export async function launchAgent(opts: LaunchOptions): Promise<number> {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));

  let resolved;
  try {
    resolved = await resolveAgent(opts.agent, {
      pinnedSpec: opts.pinnedSpec,
      pinnedSource: opts.pinnedSource,
      preferPath: useSystemAgentOptIn(),
      log
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    log(installHint(opts.agent));
    return 127;
  }

  log(resolved.displayLine);

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  const child = spawnAgent(resolved.binPath, opts.args, {
    stdio: "inherit",
    env: childEnv
  });

  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        try {
          process.kill(process.pid, signal);
        } catch {
          // fall through
        }
        resolve(128);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export function installHint(
  agent: AgentName,
  platform: NodeJS.Platform = process.platform
): string {
  const optIn = platform === "win32"
    ? '    $env:COPILLM_USE_SYSTEM_AGENT = "1"'
    : "    export COPILLM_USE_SYSTEM_AGENT=1";

  if (agent === "codex") {
    const commands = [
      "    npm i -g @openai/codex",
      "    https://github.com/openai/codex/releases"
    ];
    if (platform === "darwin") commands.unshift("    brew install codex");
    return [
      "Fallback: install Codex CLI on PATH, then opt in to the system binary:",
      ...commands,
      optIn
    ].join("\n");
  }
  if (agent === "pi") {
    return [
      "Fallback: install pi coding agent on PATH, then opt in to the system binary:",
      "    npm i -g @earendil-works/pi-coding-agent",
      optIn
    ].join("\n");
  }
  if (agent === "copilot") {
    const commands = [
      "    npm i -g @github/copilot",
      "    https://github.com/github/copilot-cli/releases"
    ];
    if (platform === "win32") commands.unshift("    winget install GitHub.Copilot");
    if (platform === "darwin") commands.unshift("    brew install --cask copilot-cli");
    return [
      "Fallback: install GitHub Copilot CLI on PATH, then opt in to the system binary:",
      ...commands,
      optIn
    ].join("\n");
  }
  return [
    "Fallback: install Claude Code on PATH, then opt in to the system binary:",
    "    npm i -g @anthropic-ai/claude-code",
    optIn
  ].join("\n");
}

/**
 * Whether the user has opted in to letting copillm fall back to a system-installed
 * coding-agent binary on PATH. Off by default — copillm uses its own cache and
 * downloads on demand so the executed version is deterministic.
 *
 * Opt in by setting `COPILLM_USE_SYSTEM_AGENT` to `1`, `true`, or `yes`
 * (case-insensitive).
 */
function useSystemAgentOptIn(): boolean {
  const raw = process.env.COPILLM_USE_SYSTEM_AGENT;
  if (!raw) return false;
  return /^(1|true|yes)$/i.test(raw.trim());
}
