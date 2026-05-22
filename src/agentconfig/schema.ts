import { z } from "zod";

/**
 * Schema for `~/.copillm/agent.toml` (global) and `<cwd>/.copillm/agent.toml`
 * (project overlay). See plans/unified-booping-mango.md for design rationale.
 *
 * Sections under `[defaults.*]` apply to every profile; profiles override by
 * deep-merge. v1 only wires `instructions` and `mcp` into fan-out — the other
 * sections (`skills`, `agents`, `hooks`, `permissions`) are reserved-but-
 * permissive so users can start populating them without future TOML breaking.
 */

export const UNSET_SENTINEL = "@unset";

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

const McpInheritUnset = z
  .object({
    inherit: z.literal(UNSET_SENTINEL)
  })
  .strict();

export const McpServerSchema = z.union([McpStdioSchema, McpHttpSchema, McpInheritUnset]);
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

const SectionSchema = z
  .object({
    instructions: InstructionsSchema.optional(),
    mcp: McpSchema.optional(),
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
  // Reserved-but-empty in v1; surfaced for `copillm config show` so users see
  // their data is loaded even though no renderer consumes it yet.
  reserved: {
    skills: Record<string, unknown>;
    agents: Record<string, unknown>;
    hooks: Record<string, unknown>;
    permissions: Record<string, unknown>;
  };
}
