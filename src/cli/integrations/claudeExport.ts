import { buildClaudeEnvBundle, type ClaudeEnvBundle } from "../agentEnv.js";
import {
  buildClaudeExportCommand as buildClaudeExport,
  computeAnthropicDefaults,
  readModelIdsFromCache,
  type AnthropicDefaults
} from "../../models/anthropicDefaults.js";
import type { AgentSessionScope } from "../../config/home.js";

export function buildClaudeExportCommand(
  port: number,
  callerSecret: null | string,
  opts?: {
    pathPrefix?: string;
    cacheId?: string;
    sessionScope?: AgentSessionScope;
    profileName?: string | null;
  }
): { command: string; defaults: AnthropicDefaults; bundle: ClaudeEnvBundle } {
  const pathPrefix = opts?.pathPrefix ?? "";
  const modelIds = readModelIdsFromCache(opts?.cacheId);
  const defaults = computeAnthropicDefaults(modelIds);
  const bundle = buildClaudeEnvBundle({
    port,
    callerSecret,
    defaults,
    enableGatewayDiscovery: true,
    pathPrefix,
    sessionScope: opts?.sessionScope,
    profileName: opts?.profileName
  });
  const command = buildClaudeExport({
    port,
    callerSecret,
    defaults,
    enableGatewayDiscovery: true,
    pathPrefix,
    configDir: bundle.env.CLAUDE_CONFIG_DIR
  });
  return { command, defaults, bundle };
}
