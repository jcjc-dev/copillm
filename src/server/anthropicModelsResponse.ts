import type { CopilotModel } from "../models/discovery.js";
import { toAnthropicSurfaceModelId } from "../models/claudeModelId.js";

interface AnthropicModelEntry {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
}

interface AnthropicModelsResponse {
  data: AnthropicModelEntry[];
  has_more: boolean;
  first_id: null | string;
  last_id: null | string;
}

/**
 * Claude Code's only client-side marker for a 1M-context-budget model is a
 * literal `[1m]` suffix on the model id (matched in its binary via
 * `id.includes("opus") && id.includes("[1m]")` for opus and
 * `id.includes("sonnet[1m]") || id.includes("sonnet-4-6[1m]")` for sonnet).
 * Without it, Claude Code falls back to its hardcoded 200K per-model cap for
 * unrecognised model ids and auto-compacts conversations well before they
 * approach the model's real conversation budget.
 *
 * Aliasing the advertised id with `[1m]` is the only way to unlock Claude
 * Code's 1M-class autocompact behaviour via the gateway discovery path —
 * the `/anthropic/v1/models` response shape itself has no field for a numeric
 * context window (Claude Code only reads `id` + `display_name`).
 *
 * Request bodies that carry an aliased id are normalised back to the
 * canonical upstream id before being forwarded (see
 * `stripOneMillionAlias` in `src/translation/openaiAnthropic.ts` and the
 * defensive strip in `src/server/proxy.ts`).
 */
export const ONE_M_ALIAS_SUFFIX = "[1m]";
const ONE_M_CONTEXT_THRESHOLD_TOKENS = 1_000_000;

export function buildAnthropicModelsResponse(models: readonly CopilotModel[]): AnthropicModelsResponse {
  const filtered = models.filter(isAnthropicSurfaceEligible);
  const nowIso = new Date().toISOString();
  const data: AnthropicModelEntry[] = filtered.map((model) => ({
    type: "model",
    id: applyOneMillionAlias(model),
    display_name: extractDisplayName(model),
    created_at: extractCreatedAt(model) ?? nowIso
  }));
  return {
    data,
    has_more: false,
    first_id: data.length > 0 ? data[0].id : null,
    last_id: data.length > 0 ? data[data.length - 1].id : null
  };
}

/**
 * Append `[1m]` to a model id when (and only when) the upstream catalog
 * reports `capabilities.limits.max_context_window_tokens >= 1_000_000` AND
 * the id contains `opus`.
 *
 * Claude Code's 1M-tier matchers (extracted from its binary) only fire for
 * opus models:
 *
 *   dN3(id) = !... && !... && id.toLowerCase().includes("opus") && id.toLowerCase().includes("[1m]")
 *
 * The sonnet matcher (`cN3`) requires the literal substring `sonnet[1m]` or
 * `sonnet-4-6[1m]`, which doesn't fit copillm-aliased ids (an aliased
 * sonnet would end in `[1m]` but its base would not contain a contiguous
 * `sonnet[1m]` substring), so a `[1m]` suffix on a sonnet wouldn't unlock
 * the 1M cap anyway. And no non-Claude vendor (gpt, gemini, ...) has any
 * `[1m]` matcher at all.
 *
 * Restricting the alias to opus avoids showing a misleading `[1m]` next to
 * a non-opus model (e.g. a gpt or gemini variant) in Claude Code's `/model`
 * picker — a label that would imply 1M-class behaviour Claude Code would
 * never deliver for that vendor.
 *
 * The base id is first mapped to Claude Code's dash-separated surface form
 * (`claude-sonnet-4.6` -> `claude-sonnet-4-6`) via `toAnthropicSurfaceModelId`
 * so the advertised id is not mistaken for the deprecated `claude-sonnet-4-0`
 * (see src/models/claudeModelId.ts).
 *
 * Models already carrying the suffix are left alone. Models below the 1M
 * threshold get no alias regardless of name — Claude Code has no
 * client-side marker for the 200K-1M intermediate range, and over-claiming
 * would set the wrong autocompact trigger.
 */
export function applyOneMillionAlias(model: CopilotModel): string {
  const baseId = toAnthropicSurfaceModelId(typeof model.id === "string" ? model.id : "");
  if (baseId.endsWith(ONE_M_ALIAS_SUFFIX)) {
    return baseId;
  }
  if (!baseId.toLowerCase().includes("opus")) {
    return baseId;
  }
  const maxContext = getNested<number>(model, "capabilities", "limits", "max_context_window_tokens");
  if (typeof maxContext !== "number" || !Number.isFinite(maxContext)) {
    return baseId;
  }
  if (maxContext < ONE_M_CONTEXT_THRESHOLD_TOKENS) {
    return baseId;
  }
  return `${baseId}${ONE_M_ALIAS_SUFFIX}`;
}

/**
 * Decide which upstream Copilot models should appear in `/anthropic/v1/models`.
 *
 * The proxy's Anthropic surface (`/anthropic/v1/messages`) already translates
 * Anthropic-shape requests into OpenAI `/chat/completions` calls upstream and
 * translates responses back — see src/server/proxy.ts line ~234, which sends
 * EVERY Anthropic-surface request to `/chat/completions` regardless of the
 * model's vendor. The historical filter was a regex on model id matching
 * `^(claude|anthropic)` which silently dropped Gemini, gpt-4.1, and the
 * gpt-5.x family from the Claude Code model picker even though the translation
 * pipeline already handled them end-to-end.
 *
 * Gate eligibility on *capability* instead of vendor naming:
 *   1. `model_picker_enabled === true` — upstream marks the model as user-pickable.
 *   2. `policy.state` is "enabled" or absent — upstream policy doesn't disable it.
 *   3. `supported_endpoints` includes `/chat/completions` — the upstream actually
 *      speaks the protocol the proxy translates against.
 *
 * Models that fail any one of these don't appear in the picker. Whether a model
 * that DOES pass actually returns 2xx for a translated Anthropic request is a
 * separate concern (some gpt-5.x reasoning models reject the default
 * chat-completions body shape and 400 at runtime); that's surfaced as an
 * upstream error per request, not hidden at the catalog level.
 */
export function isAnthropicSurfaceEligible(model: CopilotModel): boolean {
  if (typeof model.id !== "string" || model.id.length === 0) {
    return false;
  }
  const pickerEnabled = getNested<boolean>(model, "model_picker_enabled") === true;
  if (!pickerEnabled) {
    return false;
  }
  const policyState = getNested<string>(model, "policy", "state");
  if (policyState !== undefined && policyState !== "enabled") {
    return false;
  }
  const supportedEndpoints = getNested<unknown[]>(model, "supported_endpoints");
  if (!Array.isArray(supportedEndpoints) || !supportedEndpoints.includes("/chat/completions")) {
    return false;
  }
  return true;
}

function getNested<T>(obj: unknown, ...keys: string[]): T | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

function extractDisplayName(model: CopilotModel): string {
  const candidate = (model as Record<string, unknown>).name;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  const displayCandidate = (model as Record<string, unknown>).display_name;
  if (typeof displayCandidate === "string" && displayCandidate.length > 0) {
    return displayCandidate;
  }
  return model.id;
}

function extractCreatedAt(model: CopilotModel): null | string {
  const candidate = (model as Record<string, unknown>).created_at;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return null;
}
