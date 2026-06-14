/**
 * Declarative registry of copillm-owned launcher flags + the processor that
 * extracts them from a raw arg tail.
 *
 * Why this exists: commander's `passThroughOptions()` stops parsing at the
 * first unrecognized token and forwards everything after it verbatim. That made
 * copillm-flag recognition order-dependent — `copillm claude
 * --dangerously-skip-permissions --copillm-profile work` leaked
 * `--copillm-profile work` straight to the agent, which then crashed on the
 * unknown option. Because every copillm flag is namespaced (`--copillm-*`) or
 * the single well-known `--yolo`, scanning the entire arg list for them is safe
 * and collision-free. This processor does exactly that, layered on top of
 * commander (which still owns subcommand routing).
 *
 * Adding a new copillm launcher flag should be one row in `COPILLM_FLAGS` plus a
 * field on `CopillmLaunchOpts` — never new parsing logic.
 */

export interface CopillmLaunchOpts {
  copillmUse?: string;
  copillmDebug?: boolean;
  copillmProfile?: string;
  copillmAccount?: string;
  copillmNoConfig?: boolean;
  yolo?: boolean;
}

export interface CopillmFlagSpec {
  /** Canonical flag token, e.g. "--copillm-profile". */
  flag: string;
  /**
   * Short aliases that should be treated identically to `flag` and swallowed
   * before the agent sees them. Deliberate design choice: copillm's flag wins
   * over any same-named agent-native flag (e.g. codex's own `--profile`).
   * Users get one mental model — `copillm <agent> --profile work` always
   * means copillm's profile — and the agent never receives the alias token.
   */
  aliases?: readonly string[];
  /** true: consumes the next token (or `=value`); false: boolean. */
  takesValue: boolean;
  /** Where the parsed value lands on CopillmLaunchOpts. */
  dest: keyof CopillmLaunchOpts;
  /**
   * "swallow": consumed entirely by copillm.
   * "translate": also drives an agent-native rewrite downstream (currently
   * only --yolo, via the AGENTS registry / applyYolo). Does not change
   * extraction logic — documents intent and lets future translate-type flags
   * be routed to a per-agent translator.
   */
  kind: "swallow" | "translate";
  /** Reused for help/diagnostics. */
  description: string;
}

export const COPILLM_FLAGS: CopillmFlagSpec[] = [
  {
    flag: "--copillm-use",
    aliases: ["--use"],
    takesValue: true,
    dest: "copillmUse",
    kind: "swallow",
    description: "Pin agent package version"
  },
  {
    flag: "--copillm-debug",
    aliases: ["--debug"],
    takesValue: false,
    dest: "copillmDebug",
    kind: "swallow",
    description: "Enable debug endpoints when auto-starting daemon"
  },
  {
    flag: "--copillm-profile",
    aliases: ["--profile"],
    takesValue: true,
    dest: "copillmProfile",
    kind: "swallow",
    description: "Override active profile for this launch"
  },
  {
    flag: "--copillm-account",
    aliases: ["--account"],
    takesValue: true,
    dest: "copillmAccount",
    kind: "swallow",
    description: "Route this launch at a specific copillm account"
  },
  {
    flag: "--copillm-no-config",
    aliases: ["--no-config"],
    takesValue: false,
    dest: "copillmNoConfig",
    kind: "swallow",
    description: "Skip agent.toml fan-out for this launch"
  },
  {
    flag: "--yolo",
    takesValue: false,
    dest: "yolo",
    kind: "translate",
    description: "Skip approvals (translated per-agent)"
  }
];

export interface ProcessResult {
  opts: CopillmLaunchOpts;
  /** Everything not recognized as a copillm flag, in original order. */
  forwarded: string[];
}

const SPEC_BY_FLAG = new Map<string, CopillmFlagSpec>();
for (const spec of COPILLM_FLAGS) {
  SPEC_BY_FLAG.set(spec.flag, spec);
  for (const alias of spec.aliases ?? []) {
    SPEC_BY_FLAG.set(alias, spec);
  }
}

/**
 * Extract copillm-owned flags from a raw arg tail, returning the parsed opts
 * plus everything else to forward to the agent.
 *
 * Extract-everywhere: copillm flags are pulled out regardless of position,
 * including after a `--` separator (the `--` itself is forwarded). Accepted
 * tradeoff: a literal `--copillm-*`/`--yolo` token cannot be passed through to
 * the agent as data. These tokens have no legitimate meaning to the agents.
 *
 * Pure function, no I/O.
 */
export function processCopillmArgs(rawArgs: readonly string[]): ProcessResult {
  const opts: CopillmLaunchOpts = {};
  const forwarded: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const spec = SPEC_BY_FLAG.get(name);

    if (!spec) {
      forwarded.push(token);
      continue;
    }

    if (spec.takesValue) {
      let value: string | undefined;
      if (eq !== -1) {
        value = token.slice(eq + 1);
      } else if (i + 1 < rawArgs.length) {
        value = rawArgs[++i];
      }
      if (value === undefined) {
        throw new Error(`${spec.flag} requires a value`);
      }
      setOpt(opts, spec.dest, value);
    } else {
      setOpt(opts, spec.dest, true);
    }
  }

  return { opts, forwarded };
}

function setOpt(opts: CopillmLaunchOpts, dest: keyof CopillmLaunchOpts, value: string | boolean): void {
  // Last-wins on repeats. dest/value pairing is guaranteed by the spec table.
  (opts as Record<string, string | boolean>)[dest] = value;
}
