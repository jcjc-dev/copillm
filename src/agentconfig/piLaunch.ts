/** Add the configured Pi model only when the user didn't pass one explicitly. */
export function applyPiModelDefault(args: readonly string[], model: string | undefined): string[] {
  if (!model || args.some((arg) => arg === "--model" || arg.startsWith("--model="))) {
    return [...args];
  }
  return [...args, "--model", model];
}
