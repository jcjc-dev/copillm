import path from "node:path";

export interface SelfSpawnCommand {
  command: string;
  args: string[];
}

interface RuntimeProcess {
  argv: readonly string[];
  execPath: string;
}

export function buildSelfSpawnCommand(subcommand: string, extraArgs: string[] = [], runtime: RuntimeProcess = process): SelfSpawnCommand {
  const entryPoint = runtime.argv[1];
  if (!entryPoint || sameExecutable(entryPoint, runtime.execPath)) {
    return { command: runtime.execPath, args: [subcommand, ...extraArgs] };
  }
  return { command: runtime.execPath, args: [entryPoint, subcommand, ...extraArgs] };
}

function sameExecutable(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
