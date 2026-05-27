import { z } from "zod";

/**
 * Schema for `~/.copillm/agent.toml` (global) and `<cwd>/.copillm/agent.toml`
 * (project overlay). See plans/unified-booping-mango.md for design rationale.
 *
 * Sections under `[defaults.*]` always apply, regardless of which profile is
 * active. A profile may override a default by re-declaring an entry with the
 * same key (e.g. `[profiles.work.mcp.servers.<name>]` replaces the same-named
 * `[defaults.mcp.servers.<name>]`). There is no way to *remove* a default from
 * a profile — defaults are intentionally always-on. v1 only wires
 * `instructions` and `mcp` into fan-out — the other
 * sections (`skills`, `agents`, `hooks`, `permissions`) are reserved-but-
 * permissive so users can start populating them without future TOML breaking.
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

const SectionSchema = z
  .object({
    instructions: InstructionsSchema.optional(),
    mcp: McpSchema.optional(),
    yolo: YoloSchema.optional(),
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
