import {
  computeAnthropicDefaults,
  readModelIdsFromCache,
  type AnthropicDefaults
} from "../models/anthropicDefaults.js";

export interface ClaudeEnvBundle {
  env: Record<string, string>;
  inlineComments: Record<string, string>;
  trailingNotes: string[];
  defaults: AnthropicDefaults;
}

export interface CodexEnvBundle {
  env: Record<string, string>;
  inlineComments: Record<string, string>;
  trailingNotes: string[];
}

export interface PiEnvBundle {
  env: Record<string, string>;
  inlineComments: Record<string, string>;
  trailingNotes: string[];
}

export function buildClaudeEnvBundle(input: {
  port: number;
  callerSecret: null | string;
  defaults?: AnthropicDefaults;
  enableGatewayDiscovery?: boolean;
}): ClaudeEnvBundle {
  const defaults = input.defaults ?? computeAnthropicDefaults(readModelIdsFromCache());
  const enableGateway = input.enableGatewayDiscovery !== false;

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${input.port}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: input.callerSecret ?? "copillm-local"
  };
  const trailingNotes: string[] = [];

  if (defaults.opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = defaults.opus;
  } else {
    trailingNotes.push("no opus variant detected — set ANTHROPIC_DEFAULT_OPUS_MODEL manually");
  }
  if (defaults.sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = defaults.sonnet;
  } else {
    trailingNotes.push("no sonnet variant detected — set ANTHROPIC_DEFAULT_SONNET_MODEL manually");
  }
  if (defaults.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = defaults.haiku;
  } else {
    trailingNotes.push("no haiku variant detected — set ANTHROPIC_DEFAULT_HAIKU_MODEL manually");
  }

  if (enableGateway) {
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  }

  return { env, inlineComments: {}, trailingNotes, defaults };
}

export function buildCodexEnvBundle(absHomeDir: string): CodexEnvBundle {
  return {
    env: { CODEX_HOME: absHomeDir },
    inlineComments: {},
    trailingNotes: []
  };
}

/**
 * Pi has no environment-variable override for its config directory; it reads
 * `~/.pi/agent/models.json` unconditionally. So this bundle is intentionally
 * empty — the real configuration work happens in `generatePiHome()` writing
 * that file. We expose the helper for symmetry with the other agents and to
 * carry a trailing note explaining what to look at when debugging.
 */
export function buildPiEnvBundle(absMirrorDir: string): PiEnvBundle {
  return {
    env: {},
    inlineComments: {},
    trailingNotes: [
      `pi reads ~/.pi/agent/models.json directly (no env var override).`,
      `copillm regenerated it on \`copillm start\` and mirrored it at ${absMirrorDir}/models.json.`
    ]
  };
}
