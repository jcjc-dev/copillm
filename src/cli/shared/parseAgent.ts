import type { AgentName } from "../../integrations/registry.js";

export function parseAgentName(raw: string): AgentName {
  const v = raw.trim().toLowerCase();
  if (v === "codex" || v === "claude" || v === "pi" || v === "copilot") return v;
  throw new Error(`Unknown agent: ${raw}. Expected "codex", "claude", "pi", or "copilot".`);
}
