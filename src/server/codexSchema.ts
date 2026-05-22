import type { CopilotModel } from "../models/discovery.js";

interface ReasoningEffortPreset {
  effort: string;
  description: string;
}

interface CodexModelInfo {
  slug: string;
  display_name: string;
  description: string;
  default_reasoning_level: string;
  supported_reasoning_levels: ReasoningEffortPreset[];
  shell_type: string;
  visibility: "list" | "hide";
  supported_in_api: boolean;
  priority: number;
  additional_speed_tiers: string[];
  service_tiers: unknown[];
  availability_nux: null;
  upgrade: null;
  base_instructions: string;
  model_messages: null;
  supports_reasoning_summaries: boolean;
  default_reasoning_summary: string;
  support_verbosity: boolean;
  default_verbosity: null;
  apply_patch_tool_type: null;
  web_search_tool_type: string;
  truncation_policy: { mode: string; limit: number };
  supports_parallel_tool_calls: boolean;
  supports_image_detail_original: boolean;
  context_window: number | null;
  max_context_window: number | null;
  auto_compact_token_limit: null;
  effective_context_window_percent: number;
  experimental_supported_tools: string[];
  input_modalities: string[];
  supports_search_tool: boolean;
}

const VALID_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);

function toReasoningEffort(value: unknown): string {
  if (typeof value === "string" && VALID_REASONING_EFFORTS.has(value)) {
    return value;
  }
  return "medium";
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

export function isCodexEligible(model: CopilotModel): boolean {
  const pickerEnabled = getNested<boolean>(model, "model_picker_enabled") === true;
  if (!pickerEnabled) {
    return false;
  }
  const policyState = getNested<string>(model, "policy", "state");
  if (policyState !== undefined && policyState !== "enabled") {
    return false;
  }
  const supportedEndpoints = getNested<unknown[]>(model, "supported_endpoints");
  if (!Array.isArray(supportedEndpoints) || !supportedEndpoints.includes("/responses")) {
    return false;
  }
  return true;
}

export function mapCopilotModelToCodex(model: CopilotModel): CodexModelInfo {
  const supportsReasoning = getNested<unknown[]>(model, "capabilities", "supports", "reasoning_effort");
  const reasoningArray = Array.isArray(supportsReasoning) ? supportsReasoning : ["medium"];
  const supportedLevels: ReasoningEffortPreset[] = reasoningArray.map((effort) => ({
    effort: toReasoningEffort(effort),
    description: String(effort)
  }));

  const contextWindow = getNested<number>(model, "capabilities", "limits", "max_context_window_tokens") ?? null;
  const parallelTools = getNested<boolean>(model, "capabilities", "supports", "parallel_tool_calls") === true;
  const pickerEnabled = getNested<boolean>(model, "model_picker_enabled") === true;
  const vendor = getNested<string>(model, "vendor") ?? "Unknown";
  const displayName = getNested<string>(model, "name") ?? model.id;

  // Derive vision support from the upstream Copilot capability flag rather
  // than advertising image input for every model. Models without
  // `capabilities.supports.vision === true` (e.g. gpt-3.5-turbo, gpt-4-0613,
  // gpt-4o-mini) would 400 on image content if we claimed otherwise.
  // `capabilities.limits.vision` (when present) carries per-model image
  // budgets — image count, byte size, allowed media types. We don't surface
  // those limits in Codex's schema (it has no field for them today), but the
  // boolean gate alone is enough to prevent advertising image_modality on
  // text-only models.
  const supportsVision = getNested<boolean>(model, "capabilities", "supports", "vision") === true;

  return {
    slug: model.id,
    display_name: displayName,
    description: `${vendor} model: ${model.id}`,
    default_reasoning_level: toReasoningEffort(reasoningArray[0] ?? "medium"),
    supported_reasoning_levels: supportedLevels,
    shell_type: "default",
    visibility: pickerEnabled ? "list" : "hide",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "",
    model_messages: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: parallelTools,
    supports_image_detail_original: supportsVision,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: supportsVision ? ["text", "image"] : ["text"],
    supports_search_tool: false
  };
}

export function buildCodexCatalog(models: readonly CopilotModel[]): { models: CodexModelInfo[] } {
  return {
    models: models.filter(isCodexEligible).map(mapCopilotModelToCodex)
  };
}
