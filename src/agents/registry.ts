/**
 * Per-agent capability registry. The single source of truth for agent-specific
 * behaviour that copillm needs to know about (yolo mapping, future: model
 * pinning, debug surfaces, etc.). Adding a new agent should be one row here
 * plus wiring in `src/cli.ts` — never a new branch in the action handlers.
 *
 * Note: the `AgentName` union lives in `../integrations/registry.ts` (paired
 * with npm package / bin name metadata). We reuse it here so the two
 * registries can never diverge.
 */

import type { AgentName } from "../integrations/registry.js";

export type { AgentName };

export type YoloSpec =
  /** Prepend `flags` to the forwarded argv. Skip if any of them is already present. */
  | { mode: "inject"; flags: string[] }
  /** Agent already understands `--yolo`; just make sure it's in argv. */
  | { mode: "passthrough" }
  /** No equivalent exists; warn the user and forward argv unchanged. */
  | { mode: "unsupported"; reason: string };

export interface AgentSpec {
  name: AgentName;
  yolo: YoloSpec;
}

export const AGENTS: Record<AgentName, AgentSpec> = {
  claude: {
    name: "claude",
    yolo: { mode: "inject", flags: ["--dangerously-skip-permissions"] }
  },
  codex: {
    name: "codex",
    yolo: { mode: "inject", flags: ["--dangerously-bypass-approvals-and-sandbox"] }
  },
  copilot: {
    name: "copilot",
    yolo: { mode: "inject", flags: ["--allow-all"] }
  },
  pi: {
    name: "pi",
    yolo: {
      mode: "unsupported",
      reason: "pi has no blanket-approve flag; use its per-tool approvals instead"
    }
  }
};

export interface ApplyYoloOptions {
  agent: AgentName;
  userArgs: readonly string[];
  yolo: boolean;
  /** Sink for the "unsupported" warning. Defaults to process.stderr. */
  warn?: (line: string) => void;
}

/**
 * Resolve `--yolo` for a given agent and return the (possibly transformed)
 * argv to forward downstream. Pure function aside from the optional warning
 * sink — easy to unit-test.
 */
export function applyYolo(options: ApplyYoloOptions): string[] {
  const args = [...options.userArgs];
  if (!options.yolo) return args;

  const spec = AGENTS[options.agent].yolo;
  switch (spec.mode) {
    case "inject": {
      const alreadyPresent = spec.flags.some((flag) => args.includes(flag));
      if (alreadyPresent) return args;
      return [...spec.flags, ...args];
    }
    case "passthrough": {
      if (args.includes("--yolo")) return args;
      return ["--yolo", ...args];
    }
    case "unsupported": {
      const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
      warn(`copillm: --yolo ignored for ${options.agent} (${spec.reason})`);
      return args;
    }
  }
}

/**
 * Read the `COPILLM_YOLO` env var as a boolean. Accepts "1", "true", "yes"
 * (case-insensitive) as truthy; everything else (including unset) is false.
 */
export function yoloFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.COPILLM_YOLO?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Combine the per-launch flag with the env var fallback. */
export function resolveYolo(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(flag) || yoloFromEnv(env);
}
