import {
  computeAnthropicDefaults,
  readModelIdsFromCache,
  type AnthropicDefaults
} from "../models/anthropicDefaults.js";
import { claudeConfigDir, piAgentDir } from "../config/home.js";

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
    ANTHROPIC_AUTH_TOKEN: input.callerSecret ?? "copillm-local",
    // Point Claude at a copillm-owned config home so copillm-launched Claude
    // never reads/writes the user's real ~/.claude (and dev mode isolates it).
    CLAUDE_CONFIG_DIR: claudeConfigDir()
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
 * pi reads its config from `<PI_CODING_AGENT_DIR>/models.json`. copillm owns
 * that directory (see `piAgentDir()` in src/config/home.ts) and exports
 * `PI_CODING_AGENT_DIR` so the launched pi reads the catalog copillm just wrote
 * there — never the user's real `~/.pi`. This is also what makes dev mode
 * isolate pi for free (the dev COPILLM_HOME relocates the agent dir).
 */
export function buildPiEnvBundle(absMirrorDir: string): PiEnvBundle {
  const agentDir = piAgentDir();
  return {
    env: { PI_CODING_AGENT_DIR: agentDir },
    inlineComments: {},
    trailingNotes: [
      `pi reads ${agentDir}/models.json (copillm sets PI_CODING_AGENT_DIR).`,
      `copillm regenerated it on \`copillm start\` and mirrored it at ${absMirrorDir}/models.json.`
    ]
  };
}
