import { spawn } from "node:child_process";
import { resolveAgent, type AgentName } from "./resolveAgent.js";

export interface LaunchOptions {
  agent: AgentName;
  args: string[];
  env: Record<string, string>;
  pinnedSpec?: string;
  log?: (line: string) => void;
}

export async function launchAgent(opts: LaunchOptions): Promise<number> {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));

  let resolved;
  try {
    resolved = await resolveAgent(opts.agent, { pinnedSpec: opts.pinnedSpec, log });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    log(installHint(opts.agent));
    return 127;
  }

  log(resolved.displayLine);

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved.binPath);
  const child = spawn(resolved.binPath, opts.args, {
    stdio: "inherit",
    env: childEnv,
    shell: useShell
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

function installHint(agent: AgentName): string {
  if (agent === "codex") {
    return [
      "Hint: install Codex CLI manually with one of:",
      "    brew install codex",
      "    npm i -g @openai/codex",
      "    https://github.com/openai/codex/releases"
    ].join("\n");
  }
  if (agent === "pi") {
    return [
      "Hint: install pi coding agent manually with:",
      "    npm i -g @earendil-works/pi-coding-agent"
    ].join("\n");
  }
  if (agent === "copilot") {
    return [
      "Hint: install GitHub Copilot CLI manually with one of:",
      "    brew install --cask github-copilot-cli",
      "    npm i -g @github/copilot",
      "    https://github.com/github/copilot-cli"
    ].join("\n");
  }
  return [
    "Hint: install Claude Code manually with:",
    "    npm i -g @anthropic-ai/claude-code"
  ].join("\n");
}
