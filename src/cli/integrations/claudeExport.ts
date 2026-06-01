import { buildClaudeEnvBundle, type ClaudeEnvBundle } from "../agentEnv.js";
import {
  buildClaudeExportCommand as buildClaudeExport,
  computeAnthropicDefaults,
  readModelIdsFromCache,
  type AnthropicDefaults
} from "../../models/anthropicDefaults.js";

export function buildClaudeExportCommand(
  port: number,
  callerSecret: null | string
): { command: string; defaults: AnthropicDefaults; bundle: ClaudeEnvBundle } {
  const modelIds = readModelIdsFromCache();
  const defaults = computeAnthropicDefaults(modelIds);
  const command = buildClaudeExport({
    port,
    callerSecret,
    defaults,
    enableGatewayDiscovery: true
  });
  const bundle = buildClaudeEnvBundle({ port, callerSecret, defaults, enableGatewayDiscovery: true });
  return { command, defaults, bundle };
}
