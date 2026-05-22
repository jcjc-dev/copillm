import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { getCopillmHome } from "../config/home.js";
import { ensureSecureDirectory, writeFileSecureAtomic } from "../config/fsSecurity.js";
import { AgentConfigError, loadAgentConfig } from "../agentconfig/load.js";
import { applyAgentConfig, formatApplyNotes } from "../agentconfig/apply.js";
import type { AgentKind } from "../agentconfig/render.js";

const SCAFFOLD_TOML = `# copillm agent config — one source of truth for instructions and MCP servers
# fanned out to each coding agent on \`copillm <agent>\` launch.
# See: https://github.com/jcjc-dev/copillm (plans/unified-booping-mango.md)

active_profile = "default"

[defaults.instructions]
body = ""

# Uncomment to add an MCP server visible to every profile:
# [defaults.mcp.servers.github]
# transport = "http"
# url = "https://api.githubcopilot.com/mcp/"
# headers = { Authorization = "Bearer \${GITHUB_TOKEN}" }

[profiles.default]
`;

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Manage ~/.copillm/agent.toml (unified agent config)");

  config
    .command("init")
    .description("Scaffold ~/.copillm/agent.toml with an empty default profile")
    .option("--force", "Overwrite an existing agent.toml", false)
    .action((opts: { force?: boolean }) => {
      const target = path.join(getCopillmHome(), "agent.toml");
      if (fs.existsSync(target) && !opts.force) {
        process.stderr.write(`${target} already exists; pass --force to overwrite.\n`);
        process.exit(1);
      }
      ensureSecureDirectory(path.dirname(target));
      writeFileSecureAtomic(target, SCAFFOLD_TOML, 0o600);
      process.stdout.write(`Scaffolded ${target}\n`);
    });

  config
    .command("show")
    .description("Print the resolved profile (post-merge, post-env-expansion)")
    .option("--profile <name>", "Resolve a specific profile instead of the active one")
    .action((opts: { profile?: string }) => {
      try {
        const result = loadAgentConfig({ cwd: process.cwd(), profileOverride: opts.profile ?? null });
        if (!result) {
          process.stdout.write("No ~/.copillm/agent.toml or ./.copillm/agent.toml found.\n");
          return;
        }
        process.stdout.write(`active profile: ${result.active}\n`);
        process.stdout.write(`sources:\n`);
        for (const src of result.sources) {
          process.stdout.write(`  - ${src.scope}: ${src.path}\n`);
        }
        process.stdout.write(`\nresolved:\n${JSON.stringify(result.resolved, null, 2)}\n`);
      } catch (error) {
        handleAgentConfigError(error);
      }
    });

  const profile = config.command("profile").description("Profile management");

  profile
    .command("list")
    .description("List all profiles in the global agent.toml")
    .action(() => {
      const target = path.join(getCopillmHome(), "agent.toml");
      if (!fs.existsSync(target)) {
        process.stdout.write("No global agent.toml. Run `copillm config init` first.\n");
        return;
      }
      try {
        const parsed = parseToml(fs.readFileSync(target, "utf8")) as {
          active_profile?: string;
          profiles?: Record<string, unknown>;
        };
        const active = parsed.active_profile ?? "default";
        const names = Object.keys(parsed.profiles ?? {});
        if (names.length === 0) {
          process.stdout.write("No profiles defined. Add [profiles.<name>] to agent.toml.\n");
          return;
        }
        for (const name of names) {
          process.stdout.write(`${name === active ? "* " : "  "}${name}\n`);
        }
      } catch (error) {
        handleAgentConfigError(error);
      }
    });

  profile
    .command("use <name>")
    .description("Set active_profile in the global agent.toml")
    .action((name: string) => {
      const target = path.join(getCopillmHome(), "agent.toml");
      if (!fs.existsSync(target)) {
        process.stderr.write("No global agent.toml. Run `copillm config init` first.\n");
        process.exit(1);
      }
      try {
        const raw = fs.readFileSync(target, "utf8");
        const parsed = parseToml(raw) as Record<string, unknown> & { profiles?: Record<string, unknown> };
        if (!parsed.profiles || !(name in parsed.profiles)) {
          process.stderr.write(
            `Profile "${name}" not found. Existing: ${Object.keys(parsed.profiles ?? {}).join(", ") || "(none)"}\n`
          );
          process.exit(1);
        }
        parsed.active_profile = name;
        writeFileSecureAtomic(target, stringifyToml(parsed), 0o600);
        process.stdout.write(`active_profile = "${name}"\n`);
      } catch (error) {
        handleAgentConfigError(error);
      }
    });

  config
    .command("sync")
    .description("Run fan-out without launching an agent (debug aid)")
    .requiredOption("--agent <kind>", "codex | claude | pi | copilot")
    .option("--profile <name>", "Override active profile for this run")
    .action((opts: { agent: string; profile?: string }) => {
      const agent = opts.agent as AgentKind;
      if (!["codex", "claude", "pi", "copilot"].includes(agent)) {
        process.stderr.write(`Unknown agent kind "${opts.agent}".\n`);
        process.exit(1);
      }
      try {
        const result = applyAgentConfig({
          agent,
          cwd: process.cwd(),
          profileOverride: opts.profile ?? null,
          codexHomeDir: agent === "codex" ? path.join(getCopillmHome(), "codex") : undefined
        });
        for (const line of formatApplyNotes(result, agent)) {
          process.stdout.write(`${line}\n`);
        }
        if (result.active === null) {
          process.stdout.write("(no agent.toml — nothing to do)\n");
        }
      } catch (error) {
        handleAgentConfigError(error);
      }
    });
}

function handleAgentConfigError(error: unknown): never {
  if (error instanceof AgentConfigError) {
    process.stderr.write(`copillm config: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
