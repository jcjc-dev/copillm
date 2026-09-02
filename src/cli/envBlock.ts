export type AgentName = "codex" | "claude" | "pi" | "copilot";

export type ShellSyntax = "sh" | "fish" | "powershell";

export interface EnvBlockInput {
  agent: AgentName;
  env: Record<string, string>;
  shell: ShellSyntax;
  /** Environment variables whose value should be read from another variable. */
  envReferences?: Record<string, string>;
  inlineComments?: Record<string, string>;
  trailingNotes?: string[];
}

export const AGENT_DISPLAY_NAMES: Record<AgentName, string> = {
  codex: "Codex CLI",
  claude: "Claude Code",
  pi: "pi coding agent",
  copilot: "GitHub Copilot CLI"
};

export function renderEnvBlock(input: EnvBlockInput): string {
  const lines: string[] = [];
  lines.push(`# ${AGENT_DISPLAY_NAMES[input.agent]} \u2192 copillm`);
  for (const [key, value] of Object.entries(input.env)) {
    const line = input.envReferences?.[key]
      ? renderEnvReferenceLine(key, input.envReferences[key], input.shell)
      : renderEnvLine(key, value, input.shell);
    const comment = input.inlineComments?.[key];
    lines.push(comment ? `${line}    # ${comment}` : line);
  }
  if (input.trailingNotes) {
    for (const note of input.trailingNotes) {
      lines.push(`# ${note}`);
    }
  }
  return lines.join("\n");
}

export function renderEnvLine(key: string, value: string, shell: ShellSyntax): string {
  switch (shell) {
    case "sh":
      return `export ${key}="${escapeForDoubleQuotes(value)}"`;
    case "fish":
      return `set -gx ${key} "${escapeForDoubleQuotes(value)}"`;
    case "powershell":
      return `$env:${key} = "${escapeForPowerShellDoubleQuotes(value)}"`;
  }
}

function renderEnvReferenceLine(key: string, source: string, shell: ShellSyntax): string {
  switch (shell) {
    case "sh":
      return `export ${key}="\${${source}}"`;
    case "fish":
      return `set -gx ${key} "\$${source}"`;
    case "powershell":
      return `$env:${key} = $env:${source}`;
  }
}

export function isShellSyntax(value: string): value is ShellSyntax {
  return value === "sh" || value === "fish" || value === "powershell";
}

function escapeForDoubleQuotes(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

function escapeForPowerShellDoubleQuotes(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}
