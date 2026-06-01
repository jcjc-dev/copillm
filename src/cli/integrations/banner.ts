import type { generateCodexHome } from "../../integrations/codex/init.js";
import type { PiInitResult } from "../../integrations/pi/init.js";

export function displayHomePath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return p.replace(home, "~");
  }
  return p;
}

export function formatStartBanner(input: {
  port: number;
  pid: number;
  mode: "foreground" | "detached" | "already_running";
  debug: boolean;
  debugLogPath: null | string;
  codex: null | Awaited<ReturnType<typeof generateCodexHome>>;
  pi: PiInitResult | null;
}): string {
  const verb = input.mode === "foreground" ? "listening on" : "running on";
  const lines: string[] = [];
  const debugSuffix = input.debug ? " [debug]" : "";
  const modeSuffix = input.mode === "already_running" ? " (already running)" : "";
  lines.push(
    `● copillm ${verb} http://127.0.0.1:${input.port} (pid ${input.pid})${debugSuffix}${modeSuffix}`
  );
  if (input.codex) {
    lines.push(`   ${input.codex.modelCount} Copilot models discovered · default: ${input.codex.defaultModel}`);
  }
  if (input.debugLogPath) {
    lines.push(`   debug log: ${displayHomePath(input.debugLogPath)}`);
  }
  if (input.pi) {
    lines.push(`   pi: wrote ${input.pi.modelCount} models to ${displayHomePath(input.pi.configPath)}${input.pi.backupPath ? ` (backed up prior config to ${displayHomePath(input.pi.backupPath)})` : ""}`);
  }
  lines.push(``);
  lines.push(`Launch an agent against copillm:`);
  if (input.codex) {
    lines.push(`    copillm codex      # starts Codex CLI, preconfigured`);
  }
  lines.push(`    copillm claude     # starts Claude Code, preconfigured`);
  if (input.pi) {
    lines.push(`    copillm pi         # starts pi coding agent, preconfigured`);
  }
  lines.push(``);
  lines.push(`Or print env vars to use yourself:`);
  if (input.codex) {
    lines.push(`    copillm env codex`);
  }
  lines.push(`    copillm env claude`);
  if (input.pi) {
    lines.push(`    copillm env pi`);
  }
  return lines.join("\n");
}

export function formatStopHumanLine(
  primary: string,
  cache: { cleared: boolean; reason: null | string }
): string {
  if (cache.cleared) {
    return `${primary} Cleared Claude Code gateway cache.`;
  }
  if (cache.reason === "not_present") {
    return primary;
  }
  return `${primary} Could not clear Claude Code gateway cache: ${cache.reason ?? "unknown error"}.`;
}
