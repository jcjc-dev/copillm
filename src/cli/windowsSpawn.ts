import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let escaped = `${arg}`;
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(META_CHARS, "^$1");
  if (doubleEscapeMetaChars) {
    escaped = escaped.replace(META_CHARS, "^$1");
  }
  return escaped;
}

function escapeCommand(command: string): string {
  return command.replace(META_CHARS, "^$1");
}

/**
 * Build the `cmd.exe /d /s /c "..."` invocation we need to run a `.cmd` /
 * `.bat` file safely on Windows.
 *
 * Background: Node's `child_process.spawn` cannot directly exec a batch file
 * (CreateProcess only understands real PE binaries), and `shell: true` is now
 * deprecated when combined with an args array because Node performs no
 * escaping (see Node DEP0190). The accepted alternative — long used by
 * cross-spawn and npm's own bin shims — is to spawn `cmd.exe` ourselves,
 * pre-quote the command line, and set `windowsVerbatimArguments: true` so
 * Node hands the buffer to Windows untouched.
 *
 * The quoting follows the well-known two-layer algorithm:
 *   1. Apply Microsoft's CommandLineToArgvW rules (backslash/quote dance) so
 *      that the underlying program parses each argument back into the values
 *      we passed in.
 *   2. Escape cmd.exe metacharacters (`^ & | < > ( ) % ! ;` etc.) with `^` so
 *      they don't get interpreted by the shell before the program sees them.
 *
 * `doubleEscape` is needed when the target is an npm-generated `.cmd` shim
 * (which itself spawns a nested cmd.exe via `CALL` on older npm versions, or
 * via subshell composition); each cmd.exe parse strips one layer of `^`, so
 * we apply it twice to survive the round trip. We default to true for
 * `.cmd`/`.bat` because every agent we launch is installed via npm.
 */
export function buildWindowsCmdInvocation(
  file: string,
  args: string[],
  doubleEscape = true
): { command: string; args: string[] } {
  const escapedCommand = escapeCommand(file);
  const escapedArgs = args.map((a) => escapeArgument(a, doubleEscape));
  const commandLine = [escapedCommand, ...escapedArgs].join(" ");
  const comspec = process.env.ComSpec || process.env.comspec || "cmd.exe";
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`]
  };
}

/**
 * Spawn a child process, transparently routing `.cmd` / `.bat` files through
 * `cmd.exe` with safe quoting on Windows. Non-Windows platforms and real
 * `.exe` / `.com` binaries go through a direct `spawn` with no shell flag.
 *
 * Mirrors the surface of `child_process.spawn(file, args, options)` but
 * never sets `shell: true` and therefore never triggers Node's DEP0190
 * deprecation warning.
 */
export function spawnAgent(
  file: string,
  args: string[],
  options: SpawnOptions
): ChildProcess {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) {
    return spawn(file, args, { ...options, shell: false });
  }
  const { command, args: cmdArgs } = buildWindowsCmdInvocation(file, args);
  return spawn(command, cmdArgs, {
    ...options,
    shell: false,
    windowsVerbatimArguments: true
  });
}
