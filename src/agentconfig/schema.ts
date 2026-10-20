import { z } from "zod";

/**
 * Schema for `~/.copillm/agent.toml` (global) and `<cwd>/.copillm/agent.toml`
 * (project overlay). See plans/unified-booping-mango.md for design rationale.
 *
 * Sections under `[defaults.*]` always apply, regardless of which profile is
 * active. A profile may override a default by re-declaring an entry with the
 * same key (e.g. `[profiles.work.mcp.servers.<name>]` replaces the same-named
 * `[defaults.mcp.servers.<name>]`). There is no way to *remove* a default from
 * a profile — defaults are intentionally always-on. Rendered sections include
 * `instructions`, `mcp`, `provider`, `pi`, `pi_models`, `copilot`, and `yolo`. The
 * sections (`skills`, `agents`, `hooks`, `permissions`) remain reserved-but-
 * permissive so users can start populating them without future TOML breaking.
 * `session_scope` controls whether downstream agent state uses the historical
 * shared paths or a profile-namespaced home. A profile may also declare one
 * external model provider; the provider is fanned out to Codex, pi, and
 * Copilot CLI in each agent's native configuration shape.
 */

const StringRecord = z.record(z.string());

const McpStdioSchema = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: StringRecord.optional(),
    cwd: z.string().optional(),
    scope: z.enum(["project", "user"]).optional()
  })
  .strict();

const McpHttpSchema = z
  .object({
    transport: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: StringRecord.optional(),
    scope: z.enum(["project", "user"]).optional()
  })
  .strict();

export const McpServerSchema = z.union([McpStdioSchema, McpHttpSchema]);
export type McpServerEntry = z.infer<typeof McpStdioSchema> | z.infer<typeof McpHttpSchema>;
export type McpServerRaw = z.infer<typeof McpServerSchema>;

const InstructionsSchema = z
  .object({
    body: z.string()
  })
  .strict();

const McpSchema = z
  .object({
    servers: z.record(McpServerSchema).optional()
  })
  .strict();

const ProviderIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, "must contain only letters, digits, '.', '_' or '-'");

const ProviderModelSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

const ProviderBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must use http:// or https://");

const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name");

const ProviderTypeSchema = z.enum(["openai", "azure", "anthropic"]);

const PiThinkingFormatSchema = z.enum([
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling"
]);

const PiCompatSchema = z
  .object({
    max_tokens_field: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    thinking_format: PiThinkingFormatSchema.optional(),
    supports_developer_role: z.boolean().optional(),
    supports_reasoning_effort: z.boolean().optional(),
    supports_usage_in_streaming: z.boolean().optional(),
    requires_tool_result_name: z.boolean().optional(),
    requires_reasoning_content_on_assistant_messages: z.boolean().optional(),
    reasoning_effort_map: StringRecord.optional(),
    thinking_level_map: StringRecord.optional()
  })
  .strict();

const ProviderTargetSchema = {
  /** Override the common model for one agent without duplicating the provider. */
  model: ProviderModelSchema.optional(),
  /** Override the common endpoint for one agent without duplicating the provider. */
  base_url: ProviderBaseUrlSchema.optional(),
  /** Override the common API-key environment variable for one agent. */
  api_key_env: EnvVarNameSchema.optional()
};

const PiProviderSchema = z
  .object({
    ...ProviderTargetSchema,
    api: z.enum(["openai-completions", "openai-responses"]).default("openai-completions"),
    auth_header: z.boolean().optional(),
    compat: PiCompatSchema.optional()
  })
  .strict()
  .default({});

const CodexProviderSchema = z
  .object({
    ...ProviderTargetSchema,
    /**
     * Codex currently uses the Responses wire API. This option controls the
     * request's reasoning effort without forcing a value on providers that do
     * not implement it.
     */
    reasoning_effort: z
      .string()
      .min(1)
      .max(32)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters")
      .optional(),
    query_params: StringRecord.optional(),
    request_max_retries: z.number().int().min(0).optional(),
    stream_max_retries: z.number().int().min(0).optional(),
    stream_idle_timeout_ms: z.number().int().positive().optional()
  })
  .strict()
  .default({});

const CopilotProviderSchema = z
  .object({
    ...ProviderTargetSchema,
    offline: z.boolean().default(false)
  })
  .strict()
  .default({});

const CopilotLaunchSchema = z
  .object({
    model: ProviderModelSchema.optional(),
    reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    context_tier: z.enum(["default", "long_context"]).optional()
  })
  .strict();

export type CopilotLaunchConfig = z.infer<typeof CopilotLaunchSchema>;

const PiLaunchSchema = z
  .object({
    model: ProviderModelSchema.optional()
  })
  .strict();

export type PiLaunchConfig = z.infer<typeof PiLaunchSchema>;

/**
 * A provider is deliberately credential-by-reference: api_key_env names an
 * environment variable but no secret value can be placed in agent.toml.
 * The native renderers keep that secret in the child environment or let the
 * downstream agent resolve the variable at request time.
 */
const ExternalProviderSchema = z
  .object({
    id: ProviderIdSchema,
    name: z.string().min(1).optional(),
    type: ProviderTypeSchema.default("openai"),
    base_url: ProviderBaseUrlSchema,
    model: ProviderModelSchema,
    api_key_env: EnvVarNameSchema.optional(),
    context_window: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    input: z.array(z.enum(["text", "image"])).min(1).optional(),
    reasoning: z.boolean().default(false),
    tool_calling: z.boolean().default(true),
    streaming: z.boolean().default(true),
    supports_chat_completions: z.boolean().default(true),
    supports_responses: z.boolean().default(false),
    pi: PiProviderSchema,
    codex: CodexProviderSchema,
    copilot: CopilotProviderSchema
  })
  .strict();

export type ExternalProviderConfig = z.infer<typeof ExternalProviderSchema>;

/**
 * One model definition for a profile-scoped pi custom provider (rendered into
 * pi's `models.json`). Mirrors pi's `models` entry shape for a provider:
 * `contextWindow`/`maxTokens` use pi's camelCase keys.
 */
const PiModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.enum(["text", "image"])).optional(),
    samplingParams: z.record(z.unknown()).optional(),
    thinkingLevelMap: z.record(z.unknown()).optional()
  })
  .strict();

/**
 * A profile-scoped model provider for pi, e.g. a local vLLM/Ollama/DeepSeek
 * endpoint. copillm discovers the model list from the endpoint's OpenAI-style
 * `/models` route and renders the provider into pi's `models.json`, so pi can
 * connect and use those models alongside the copillm proxy catalog. Secrets
 * are by reference: `api_key_env` names an environment variable.
 */
const PiModelProviderSchema = z
  .object({
    name: z.string().min(1).optional(),
    base_url: z.string().url(),
    api: z
      .enum(["openai-completions", "openai-responses", "anthropic-messages"])
      .default("openai-completions"),
    api_key: z.string().optional(),
    api_key_env: EnvVarNameSchema.optional(),
    /** Path appended to `base_url` for OpenAI-style model discovery. Default `/models`. */
    discovery_path: z.string().default("/models"),
    /** Optional static model list (full pi metadata); used when discovery is off or fails. */
    models: z.array(PiModelSchema).optional(),
    /** Also query the discovery endpoint and add any discovered model ids. */
    discover_models: z.boolean().default(true)
  })
  .strict();

export type PiModelProviderConfig = z.infer<typeof PiModelProviderSchema>;

const PassthroughRecord = z.record(z.unknown());

/**
 * Per-agent yolo overrides. Keys must match the `AgentName` union in
 * `src/integrations/registry.ts`; unknown keys are rejected so typos surface
 * at config-load time rather than silently doing nothing.
 */
const YoloAgentsSchema = z
  .object({
    claude: z.boolean().optional(),
    codex: z.boolean().optional(),
    copilot: z.boolean().optional(),
    pi: z.boolean().optional()
  })
  .strict();

const YoloSchema = z
  .object({
    /** Profile-wide default applied to every supported agent unless overridden. */
    enabled: z.boolean().optional(),
    /** Per-agent overrides; takes precedence over `enabled`. */
    agents: YoloAgentsSchema.optional()
  })
  .strict();

export type YoloConfig = z.infer<typeof YoloSchema>;

export const SessionScopeSchema = z.enum(["shared", "isolated"]);
export type SessionScope = z.infer<typeof SessionScopeSchema>;

const SectionSchema = z
  .object({
    /**
     * Controls where downstream agent config and session state live. This is
     * merged with the same defaults/profile precedence as the other settings.
     */
    session_scope: SessionScopeSchema.optional(),
    instructions: InstructionsSchema.optional(),
    mcp: McpSchema.optional(),
    /** Native Copilot CLI launch defaults; only consumed by `copillm copilot`. */
    copilot: CopilotLaunchSchema.optional(),
    /** Pi launch defaults such as its default model. */
    pi: PiLaunchSchema.optional(),
    provider: ExternalProviderSchema.optional(),
    /** Profile-scoped pi custom model providers (rendered into pi's models.json). */
    pi_models: z.record(PiModelProviderSchema).optional(),
    yolo: YoloSchema.optional(),
    /**
     * Pin a copillm account for launches that use this profile. The launcher
     * routes the agent at this account unless overridden by `--account` /
     * `COPILLM_ACCOUNT`. Must name an account from `copillm auth status`.
     */
    account: z.string().min(1).optional(),
    // v1 reserved sections: validated as objects but not interpreted.
    skills: PassthroughRecord.optional(),
    agents: PassthroughRecord.optional(),
    hooks: PassthroughRecord.optional(),
    permissions: PassthroughRecord.optional()
  })
  .strict();

export type Section = z.infer<typeof SectionSchema>;

export const AgentTomlSchema = z
  .object({
    active_profile: z.string().min(1).optional(),
    defaults: SectionSchema.optional(),
    profiles: z.record(SectionSchema).optional()
  })
  .strict();

export type AgentToml = z.infer<typeof AgentTomlSchema>;

export interface ResolvedProfile {
  instructions: { body: string } | null;
  mcpServers: Record<string, McpServerEntry>;
  /** One external provider for Codex, pi, and Copilot CLI, or null for Copillm. */
  provider: ExternalProviderConfig | null;
  /** Native Copilot CLI defaults for model, reasoning effort, and context tier. */
  copilot: CopilotLaunchConfig | null;
  /** Pi launch preferences merged from defaults, profile, and project layers. */
  pi: PiLaunchConfig | null;
  /** Profile-scoped pi custom model providers keyed by provider id. */
  piModels: Record<string, PiModelProviderConfig>;
  /** Resolved downstream agent state policy; defaults to the legacy shared paths. */
  sessionScope: SessionScope;
  /**
   * Account this profile pins launches to, or null when unset. The launcher
   * applies precedence `--account` > `COPILLM_ACCOUNT` > this > default.
   */
  account: string | null;
  /**
   * Merged yolo settings from defaults + active profile. Null when no layer
   * declared a [...yolo] block; callers should treat that as "no opinion" and
   * fall back to the explicit --yolo flag / COPILLM_YOLO env var.
   */
  yolo: YoloConfig | null;
  // Reserved-but-empty in v1; surfaced for `copillm config show` so users see
  // their data is loaded even though no renderer consumes it yet.
  reserved: {
    skills: Record<string, unknown>;
    agents: Record<string, unknown>;
    hooks: Record<string, unknown>;
    permissions: Record<string, unknown>;
  };
}
