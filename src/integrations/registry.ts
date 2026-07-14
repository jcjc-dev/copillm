export type AgentName = "codex" | "claude" | "pi" | "copilot";

export interface AgentIntegration {
  npmPackage: string;
  binName: string;
  nativeBinaryPackagePrefix?: string;
}

export const AGENT_REGISTRY: Record<AgentName, AgentIntegration> = {
  claude:  {
    npmPackage: "@anthropic-ai/claude-code",
    binName: "claude",
    nativeBinaryPackagePrefix: "@anthropic-ai/claude-code"
  },
  codex:   { npmPackage: "@openai/codex",                   binName: "codex"   },
  pi:      { npmPackage: "@earendil-works/pi-coding-agent", binName: "pi"      },
  copilot: { npmPackage: "@github/copilot",                 binName: "copilot" },
};
