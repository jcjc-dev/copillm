/**
 * Bidirectional mapping between the **upstream Copilot** Claude model id form
 * and the form Claude Code's model registry expects.
 *
 * GitHub Copilot's catalog names Claude models with a dotted minor version:
 *
 *   claude-sonnet-4.6   claude-opus-4.8   claude-haiku-4.5
 *
 * Claude Code, however, keys its internal model registry on a dash-separated
 * form (`claude-sonnet-4-6`) and carries a legacy canonicaliser that maps any
 * unrecognised `claude-sonnet-4…` / `claude-opus-4…` string to the original,
 * now-deprecated `claude-sonnet-4-0` / `claude-opus-4-0` (extracted from the
 * Claude Code binary):
 *
 *   if (e.includes("claude-sonnet-4-6"))         return "claude-sonnet-4-6";
 *   if (e.includes("claude-sonnet-4-5"))         return "claude-sonnet-4-5";
 *   if (/claude-sonnet-4(?!-\d(?!\d))/.test(e))  return "claude-sonnet-4-0"; // deprecated
 *   …same shape for opus…
 *
 * A dotted id like `claude-sonnet-4.6` slips past the specific `includes`
 * checks (they look for a dash) and is caught by the loose regex, so Claude
 * Code believes it is running the deprecated "Sonnet 4" — it injects
 * `You are powered by the model named Sonnet 4` into the system prompt and
 * shows a retirement warning. The dash-separated `claude-sonnet-4-6` is
 * matched by the specific branch first and is not deprecated.
 *
 * So copillm advertises / exports the **dash** form to Claude Code, and
 * rewrites it back to the **dotted** upstream form before forwarding a request
 * to Copilot (which only accepts the dotted id — a dashed id returns upstream
 * 400 `model_not_supported`).
 *
 * Both transforms are scoped to `claude-` ids and only touch the trailing
 * `<major>.<minor>` / `<major>-<minor>` version segment, so they are exact
 * inverses for every Copilot Claude id (each has a single trailing dotted
 * version). Non-claude ids (gpt, gemini — the only ids with mid-string dots
 * such as `gpt-5.3-codex`) are returned unchanged.
 */

const CLAUDE_ID_PREFIX = "claude-";

function isClaudeId(modelId: string): boolean {
  return modelId.toLowerCase().startsWith(CLAUDE_ID_PREFIX);
}

/**
 * Upstream (dotted) -> Claude Code surface (dashed).
 * `claude-sonnet-4.6` -> `claude-sonnet-4-6`. No-op for non-claude ids and for
 * ids without a trailing dotted version.
 */
export function toAnthropicSurfaceModelId(modelId: string): string {
  if (!isClaudeId(modelId)) {
    return modelId;
  }
  return modelId.replace(/(\d)\.(\d+)$/, "$1-$2");
}

/**
 * Claude Code surface (dashed) -> upstream (dotted).
 * `claude-sonnet-4-6` -> `claude-sonnet-4.6`. No-op for non-claude ids and for
 * ids whose trailing segment is not a `<digit>-<digits>` version (e.g. an
 * already-dotted id passes through unchanged).
 */
export function toUpstreamModelId(modelId: string): string {
  if (!isClaudeId(modelId)) {
    return modelId;
  }
  return modelId.replace(/(\d)-(\d+)$/, "$1.$2");
}
