import type { ApplyResult } from "../../../agentconfig/render.js";
import { applyYolo, resolveYoloWithSource } from "../../../agents/registry.js";
import type { AgentName } from "../../../integrations/registry.js";

/**
 * Shared yolo wiring for the four agent subcommands. Resolves precedence
 * (flag > env > profile > defaults > off), runs `applyYolo` with source
 * attribution so the unsupported-agent warning carries traceable origin
 * info, and emits a one-line stderr notice when yolo was turned on by a
 * config layer rather than the explicit --yolo flag (so users aren't
 * surprised by silently-skipped approvals).
 */
export function applyYoloForLaunch(params: {
  agent: AgentName;
  flag: boolean | undefined;
  applyResult: ApplyResult;
  baseArgs: string[];
}): string[] {
  const decision = resolveYoloWithSource({
    agent: params.agent,
    flag: params.flag,
    profile: {
      yolo: params.applyResult.yolo,
      profileName: params.applyResult.active
    }
  });
  if (decision.value && decision.source !== "flag" && decision.source !== "env") {
    process.stderr.write(
      `copillm: yolo enabled for ${params.agent} via ${decision.label}\n`
    );
  }
  return applyYolo({
    agent: params.agent,
    userArgs: params.baseArgs,
    yolo: decision.value,
    source: decision.source
  });
}
