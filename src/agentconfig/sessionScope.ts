import { agentStateRoot, type AgentSessionScope } from "../config/home.js";
import { loadAgentConfig } from "./load.js";

export interface SessionScopeResolution {
  /** Profile whose name namespaces isolated agent state. */
  profileName: string;
  /** Resolved downstream agent state policy. */
  scope: AgentSessionScope;
  /** Root directory used by scoped agent homes. */
  stateRoot: string;
}

/**
 * Resolve the active profile and its session policy once for a launcher.
 *
 * A missing agent.toml keeps the legacy shared behavior. The profile override
 * is still retained in that case so a future isolated config can use the same
 * launcher's path plumbing without inventing a second precedence chain.
 */
export function resolveSessionScope(input: {
  cwd: string;
  profileOverride?: string | null;
}): SessionScopeResolution {
  const loaded = loadAgentConfig({
    cwd: input.cwd,
    profileOverride: input.profileOverride ?? null
  });
  const profileName = loaded?.active ?? input.profileOverride ?? "default";
  const scope = loaded?.resolved.sessionScope ?? "shared";
  return {
    profileName,
    scope,
    stateRoot: agentStateRoot(scope, profileName)
  };
}
