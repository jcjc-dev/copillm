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
  /**
   * Where the yolo decision came from. Surfaced in the unsupported-agent
   * warning so users can trace surprising behaviour back to its origin
   * (flag vs env vs profile vs defaults).
   */
  source?: YoloSource;
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
      const sourceSuffix = options.source ? `; source: ${describeSource(options.source)}` : "";
      warn(`copillm: --yolo ignored for ${options.agent} (${spec.reason}${sourceSuffix})`);
      return args;
    }
  }
}

/**
 * Tri-state read of `COPILLM_YOLO`:
 *   - "1" | "true" | "yes" (case-insensitive)  → true   (explicit on)
 *   - "0" | "false" | "no" (case-insensitive)  → false  (explicit off; can
 *     veto config-driven yolo but not the explicit --yolo flag)
 *   - unset / empty / anything else            → undefined (no opinion)
 *
 * Returning undefined for "unset" lets `resolveYoloWithSource` fall through
 * to the config layers; previously the env var only had a truthy path.
 */
export function yoloFromEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = env.COPILLM_YOLO?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return undefined;
}

/**
 * Where a yolo decision came from. Ordered roughly by precedence (highest
 * first) for documentation; the actual precedence chain lives in
 * `resolveYoloWithSource`.
 */
export type YoloSource =
  | "flag"
  | "env"
  | "profile.agents"
  | "profile.enabled"
  | "defaults.agents"
  | "defaults.enabled"
  | "off";

export interface ProfileYoloView {
  /** Effective merged yolo block (defaults + active profile), if any. */
  yolo: { enabled?: boolean; agents?: Partial<Record<AgentName, boolean>> } | null;
  /** Name of the active profile, used to label the warning source. */
  profileName?: string | null;
}

export interface ResolveYoloInput {
  agent: AgentName;
  flag?: boolean;
  env?: NodeJS.ProcessEnv;
  profile?: ProfileYoloView | null;
}

export interface ResolvedYoloDecision {
  value: boolean;
  source: YoloSource;
  /** Human label for the source, e.g. `profile "solo"` or `COPILLM_YOLO env`. */
  label: string;
}

/**
 * Precedence (top wins):
 *   1. --yolo CLI flag
 *   2. COPILLM_YOLO env var (tri-state — explicit off counts)
 *   3. profile.agents[<agent>]
 *   4. profile.enabled
 *   5. defaults.agents[<agent>]   (folded into profile view by mergeYolo)
 *   6. defaults.enabled            (ditto)
 *   7. off
 *
 * Because `mergeYolo` already collapses defaults+profile into a single layer
 * with profile-wins semantics, we only need to consult one merged view here.
 * The source label distinguishes "profile" vs "defaults" only when we know
 * the profile name (callers pass it through `profile.profileName`).
 */
export function resolveYoloWithSource(input: ResolveYoloInput): ResolvedYoloDecision {
  if (input.flag) {
    return { value: true, source: "flag", label: "--yolo flag" };
  }
  const fromEnv = yoloFromEnv(input.env ?? process.env);
  if (fromEnv !== undefined) {
    return { value: fromEnv, source: "env", label: "COPILLM_YOLO env" };
  }
  const y = input.profile?.yolo;
  if (y) {
    const profileLabel = input.profile?.profileName
      ? `profile "${input.profile.profileName}"`
      : "agent.toml";
    const perAgent = y.agents?.[input.agent];
    if (perAgent !== undefined) {
      return { value: perAgent, source: "profile.agents", label: `${profileLabel} (agents.${input.agent})` };
    }
    if (y.enabled !== undefined) {
      return { value: y.enabled, source: "profile.enabled", label: `${profileLabel} (enabled)` };
    }
  }
  return { value: false, source: "off", label: "default off" };
}

/**
 * Back-compat shim for callers that don't (yet) thread the merged profile
 * through. Kept so older entry points keep compiling; new code should prefer
 * `resolveYoloWithSource` and pass the result's `value` + `source` into
 * `applyYolo` so unsupported-agent warnings carry attribution.
 */
export function resolveYolo(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveYoloWithSource({ agent: "claude", flag, env }).value;
}

function describeSource(source: YoloSource): string {
  switch (source) {
    case "flag":
      return "--yolo flag";
    case "env":
      return "COPILLM_YOLO env";
    case "profile.agents":
      return "profile agents map";
    case "profile.enabled":
      return "profile enabled";
    case "defaults.agents":
      return "defaults agents map";
    case "defaults.enabled":
      return "defaults enabled";
    case "off":
      return "default off";
  }
}
