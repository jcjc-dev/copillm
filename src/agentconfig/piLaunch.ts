import type { PiLaunchConfig } from "./schema.js";

/** Add the configured Pi model only when the user didn't pass one explicitly. */
export function applyPiModelDefault(args: readonly string[], model: string | undefined): string[] {
  if (!model || args.some((arg) => arg === "--model" || arg.startsWith("--model="))) {
    return [...args];
  }
  return [...args, "--model", model];
}

/** Add the configured thinking level unless the caller selected one explicitly. */
export function applyPiThinkingDefault(
  args: readonly string[],
  thinkingLevel: PiLaunchConfig["thinking_level"]
): string[] {
  if (!thinkingLevel || args.some((arg) => arg === "--thinking" || arg.startsWith("--thinking="))) {
    return [...args];
  }

  const modelArgIndex = args.findIndex((arg) => arg === "--model");
  const modelArg =
    modelArgIndex >= 0
      ? args[modelArgIndex + 1]
      : args.find((arg) => arg.startsWith("--model="))?.slice(8);
  if (modelArg && /:(off|minimal|low|medium|high|xhigh|max)$/i.test(modelArg)) {
    return [...args];
  }

  return [...args, "--thinking", thinkingLevel];
}
