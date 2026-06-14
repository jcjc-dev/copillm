import { buildClaudeEnvBundle, type ClaudeEnvBundle } from "../agentEnv.js";
import {
  buildClaudeExportCommand as buildClaudeExport,
  computeAnthropicDefaults,
  readModelIdsFromCache,
  type AnthropicDefaults
} from "../../models/anthropicDefaults.js";

export function buildClaudeExportCommand(
  port: number,
  callerSecret: null | string,
  opts?: { pathPrefix?: string; cacheId?: string }
): { command: string; defaults: AnthropicDefaults; bundle: ClaudeEnvBundle } {
  const pathPrefix = opts?.pathPrefix ?? "";
  const modelIds = readModelIdsFromCache(opts?.cacheId);
  const defaults = computeAnthropicDefaults(modelIds);
  const command = buildClaudeExport({
    port,
    callerSecret,
    defaults,
    enableGatewayDiscovery: true,
    pathPrefix
  });
  const bundle = buildClaudeEnvBundle({ port, callerSecret, defaults, enableGatewayDiscovery: true, pathPrefix });
  return { command, defaults, bundle };
}
