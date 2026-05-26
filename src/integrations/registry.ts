export type AgentName = "codex" | "claude" | "pi" | "copilot";

export interface AgentIntegration {
  npmPackage: string;
  binName: string;
}

export const AGENT_REGISTRY: Record<AgentName, AgentIntegration> = {
  claude:  { npmPackage: "@anthropic-ai/claude-code",       binName: "claude"  },
  codex:   { npmPackage: "@openai/codex",                   binName: "codex"   },
  pi:      { npmPackage: "@earendil-works/pi-coding-agent", binName: "pi"      },
  copilot: { npmPackage: "@github/copilot",                 binName: "copilot" },
};
