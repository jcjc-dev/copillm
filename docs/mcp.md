---
title: MCP & agent.toml
layout: default
nav_order: 6
---

# MCP & `agent.toml`

copillm is a **MCP and model configuration aggregator**. You declare your MCP servers and, optionally, one external model provider once in `~/.copillm/agent.toml`, and copillm fans them out to each supported coding agent's native config format on launch (`copillm claude`, `copillm codex`, `copillm pi`, or `copillm copilot`).

copillm itself does **not** speak the MCP wire protocol — it just renders the right files for each downstream agent.

## File locations

| Scope | Path | Purpose |
| ----- | ---- | ------- |
| Global | `~/.copillm/agent.toml` | Defaults + profiles available to every project |
| Project | `<cwd>/.copillm/agent.toml` | Overlay; deep-merged on top of global at load time |

If neither file exists, copillm skips fan-out entirely — your agents launch unaffected.

## Quick start

```bash
copillm config init       # scaffold ~/.copillm/agent.toml
$EDITOR ~/.copillm/agent.toml
copillm config show       # preview the resolved active profile
copillm config sync --agent claude   # write Claude's native config without launching
copillm claude            # launch, fan-out runs automatically
```

## Minimal example

```toml
active_profile = "default"

[profiles.default.mcp.servers.playwright]
transport = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@latest"]

[profiles.default.mcp.servers.github]
transport = "http"
url = "https://api.githubcopilot.com/mcp/"
headers = { Authorization = "Bearer ${GITHUB_TOKEN}" }
```

## Server schema

Every entry under `[<section>.mcp.servers.<name>]` is one of three shapes.

### stdio (local process)

```toml
[profiles.default.mcp.servers.kusto]
transport = "stdio"
command = "agency"
args = ["mcp", "kusto", "--database", "1ESPTInsights"]
env = { KUSTO_AUTH = "${KUSTO_AUTH}" }   # optional
cwd = "/opt/agency"                       # optional
scope = "user"                            # optional: "project" | "user"
```

### http / sse (remote)

```toml
[profiles.default.mcp.servers.github]
transport = "http"      # or "sse"
url = "https://api.githubcopilot.com/mcp/"
headers = { Authorization = "Bearer ${GITHUB_TOKEN}" }
scope = "user"
```

### Server name rules

Names must match `^[A-Za-z0-9_-]+$` — letters, digits, dashes, underscores. Anything else is rejected at render time (TOML identifier requirement for the Codex output).

## Profiles & merging

`agent.toml` is layered. At load time, copillm deep-merges these in order:

1. Global `[defaults]`
2. Global `[profiles.<active>]`
3. Project `[defaults]`
4. Project `[profiles.<active>]`

Later layers overwrite earlier ones. The `mcp.servers` map merges per-key: same-named entries fully replace.

**`[defaults]` is always-on.** Anything declared under `[defaults.mcp.servers.*]` (in either the global or project file) applies to every profile. A profile cannot remove a default — it can only override one by re-declaring an entry with the same name. If you need a server to be present *only* in a single profile, declare it under that profile's section, not under defaults.

`[profiles.default]` is just a profile that happens to be named `"default"` — it is **not** auto-merged into other profiles. Use `[defaults]` for that.

```toml
active_profile = "work"

[defaults.mcp.servers.playwright]
transport = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@latest"]

[profiles.default]
# playwright is always on (from [defaults]) regardless of active profile

[profiles.work.mcp.servers.ado]
transport = "stdio"
command = "agency"
args = ["mcp", "ado"]

[profiles.work.mcp.servers.playwright]
# Same name as the default → this entry replaces it under the `work` profile.
transport = "stdio"
command = "/opt/custom/playwright-mcp"
```

### Isolating agent sessions by profile

By default, every profile keeps using copillm's existing shared agent
directories. You can set the global default under `[defaults]`, then override
it for an individual profile:

```toml
[defaults]
session_scope = "shared"

[profiles.personal]
session_scope = "isolated"
```

`session_scope` accepts `shared` or `isolated`. It follows the normal config
layering order: project profile, project defaults, global profile, global
defaults, then the built-in `shared` default. Project overlays may configure
this setting just like other profile settings.

An isolated profile gets its own downstream agent state under
`~/.copillm/profiles/<profile>/`:

```text
~/.copillm/profiles/personal/claude/home
~/.copillm/profiles/personal/codex
~/.copillm/profiles/personal/pi/agent
~/.copillm/profiles/personal/copilot
```

This includes session history, agent settings, and copillm-generated agent
configuration. The copillm daemon, credentials, downloaded agent versions, and
model caches remain shared under `~/.copillm`. Isolation starts with new
directories; copillm does not automatically move existing session data.
Isolated profile names must contain only letters, digits, `.`, `_`, or `-`.

The launcher-specific home environment variables still take precedence when
you set them explicitly: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`PI_CODING_AGENT_DIR`, or `COPILOT_HOME`. In shared mode, copillm does not add
`COPILOT_HOME`, so Copilot CLI continues using its normal home.

### Switching profiles

```bash
copillm config profile list      # show all profiles, * marks active
copillm config profile use work  # set active_profile in global agent.toml
copillm config sync --agent claude --profile work   # one-off override
```

The `--profile` flag on `sync` and `show` overrides `active_profile` for that invocation only.

### Pinning an account to a profile

If you use [multiple accounts](../commands/auth/), a profile can pin which one its launches use. Add an `account` key to the profile:

```toml
[profiles.work]
account = "work"

[profiles.work.mcp.servers.ado]
transport = "stdio"
command = "agency"
args = ["mcp", "ado"]
```

Now `copillm codex --profile work` (or any launch with `work` active) routes at the `work` account. The value must name an account from `copillm auth status`. A launch's `--account` flag or the `COPILLM_ACCOUNT` env var still overrides the pin — the full precedence is `--account` > `COPILLM_ACCOUNT` > the profile's `account` > the default account.

You can also set `account` under `[defaults]` to pin a baseline account for every profile; a profile's own `account` overrides the default.

## External model providers

A profile can select one OpenAI-compatible, Azure-compatible, or
Anthropic-compatible endpoint for Codex CLI, pi, and GitHub Copilot CLI.
This is useful for a local server, a hosted provider, or a gateway that
exposes one of the supported APIs.

The provider is optional. When it is absent, copillm keeps its normal
Copilot-backed behaviour. When it is present, `copillm codex`, `copillm pi`,
and `copillm copilot` use the external endpoint and do not need a stored
GitHub credential or a running copillm daemon for that launch. Claude Code
does not use this provider block yet.

### One provider syntax

```toml
[profiles.local.provider]
id = "local-llm"
name = "Local LLM"
type = "openai"                    # openai | azure | anthropic
base_url = "http://127.0.0.1:8000/v1"
model = "your-model-id"
api_key_env = "LOCAL_LLM_API_KEY"  # omit for a keyless local endpoint

context_window = 262144
max_output_tokens = 32768
input = ["text"]                   # pi model input modes: text | image
reasoning = true
tool_calling = true
streaming = true
supports_chat_completions = true
supports_responses = true          # required by Codex; set false if unavailable

[profiles.local.provider.pi]
api = "openai-completions"         # or "openai-responses"
auth_header = false

[profiles.local.provider.pi.compat]
supports_developer_role = false
supports_reasoning_effort = false
requires_tool_result_name = true
max_tokens_field = "max_tokens"
thinking_format = "qwen"

[profiles.local.provider.codex]
reasoning_effort = "medium"
# query_params = { }

[profiles.local.provider.copilot]
offline = true
```

Common fields describe the endpoint once:

| Field | Purpose |
| ----- | ------- |
| `id` | Safe provider name used in generated configuration. |
| `name` | Optional display name. |
| `type` | Provider family: `openai`, `azure`, or `anthropic`. |
| `base_url` | Endpoint base URL. |
| `model` | Model identifier sent by default. |
| `api_key_env` | Name of an environment variable containing an API key. |
| `context_window` | Context limit used by pi. |
| `max_output_tokens` | Output limit used by pi. |
| `input` | Optional pi input modes: `text` and/or `image`. |
| `reasoning` | Whether the model supports reasoning/thinking. |
| `tool_calling` | Whether the endpoint supports tool calls. |
| `streaming` | Whether the endpoint supports streaming responses. |
| `supports_chat_completions` | Whether the endpoint accepts OpenAI Chat Completions requests. |
| `supports_responses` | Whether the endpoint accepts OpenAI Responses requests. |

The `pi`, `codex`, and `copilot` sections can override `base_url`, `model`,
and the credential environment-variable name for that agent without
duplicating the provider. Values in `pi.compat` are forwarded to pi's
compatibility settings for providers that need role, token-field, reasoning,
or thinking-format adjustments.

### How each agent uses the provider

- **Codex CLI** uses the OpenAI Responses API. Set
  `supports_responses = true`; the generated Codex configuration uses the
  selected model, endpoint, and referenced credential variable.
- **pi** uses the API selected by `provider.pi.api`. It receives one model
  entry with the context/output limits, reasoning flag, input modes, and
  compatibility options. pi reads the credential by environment-variable
  reference; the secret is not written to `models.json`.
- **GitHub Copilot CLI** uses the selected provider type and its supported
  OpenAI-compatible or Anthropic-compatible BYOK interface. The endpoint must
  support streaming and tool calls. The credential is read in memory and
  passed only to the child process. Use
  `copillm env copilot` to print a shell block that references the credential
  variable without printing its value.

Use `copillm config sync --agent <kind>` to render the selected profile
without launching an agent. Use `copillm env codex`, `copillm env pi`, or
`copillm env copilot` to print launch environment/configuration details;
external-provider variants work even when the copillm daemon is stopped.

Provider blocks are replaced as a complete object by a later project/profile
layer. This prevents an endpoint from one provider being combined with
credentials or model metadata from another. API keys must remain outside
`agent.toml`; only their environment-variable names belong in the file.

## Environment variable expansion

`${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `url`, `env` values, and `headers` values at load time:

```toml
[profiles.default.mcp.servers.github]
transport = "http"
url = "https://api.githubcopilot.com/mcp/"
headers = { Authorization = "Bearer ${GITHUB_TOKEN}" }

[profiles.default.mcp.servers.kusto]
transport = "stdio"
command = "agency"
args = ["mcp", "kusto", "--database", "${KUSTO_DB:-1ESPTInsights}"]
```

If `${VAR}` is unset and no `:-default` is provided, load fails with a clear error.

## How fan-out works per agent

`copillm <agent>` renders the resolved profile for a wrapped launch. `copillm config sync --agent <agent>` writes the resolved profile into the agent's native/default config paths so the agent can be launched directly.

### Claude Code

- `copillm claude` writes a copillm-owned MCP file to `~/.copillm/claude/mcp.json` (or the isolated profile directory) and appends `--mcp-config` for that launch. It also points Claude at a copillm-owned config home via `CLAUDE_CONFIG_DIR` (`~/.copillm/claude/home` in shared mode), so the launch never reads or writes your real `~/.claude`.
- `copillm config sync --agent claude` writes MCP servers into user scope at `~/.claude.json` and writes copillm's provider env into `~/.claude/settings.json`.
- When the active profile declares no MCP servers, the managed file is removed and no `--mcp-config` flag is added.
- Instructions fan-out is **not supported** for Claude. Place project guidance in your own `CLAUDE.md` or global guidance in `~/.claude/CLAUDE.md`.

### Codex CLI

- `copillm codex` injects a `[mcp_servers]` TOML block into `~/.copillm/codex/config.toml` (or the isolated profile directory) for the wrapped launch.
- `copillm config sync --agent codex` merges copillm's provider block into `~/.codex/config.toml` and injects the `[mcp_servers]` block there.
- The block is delimited with hash-comment markers so subsequent runs replace just the managed section.
- A Copillm-backed profile requires `copillm start` (or any prior launch) to
  have generated the base `config.toml` first. An external-provider profile
  writes its provider configuration directly and does not require the daemon.

### pi

- copillm points pi at a copillm-owned agent dir via `PI_CODING_AGENT_DIR` (`~/.copillm/pi/agent` in shared mode), so it never writes your real `~/.pi`. To launch `pi` directly (without copillm), export `PI_CODING_AGENT_DIR` to that path first.
- Writes a `copillm-mcp` extension into the selected agent directory (`extensions/copillm-mcp/`; `servers.json` + `index.ts`).
- v1 lists servers via a `/copillm-mcp` slash command; full stdio/http transport wiring is deferred to a follow-up.

### Copilot CLI

- `copillm copilot` writes a copillm-owned MCP config to `~/.copillm/copilot/mcp-config.json` (or the isolated profile directory) and appends `--additional-mcp-config @<path>` for that launch. In an isolated profile, it also sets `COPILOT_HOME` so Copilot CLI keeps its own settings and session state in that profile directory. `copillm config sync --agent copilot` writes the same managed file without launching.
- Each server is emitted with `tools: ["*"]`; stdio servers use `type: "local"`, http/sse servers keep their transport type and URL.
- When the active profile declares no MCP servers, the managed file is removed and no flag is added.

## Instructions block (bonus)

Same file also fans out instructions to Codex (`AGENTS.md`) and pi (its prompt file) inside a `<!-- copillm:managed begin/end -->` marker so the rest of those files stays yours. **Not supported for Claude or Copilot** — copillm never writes to `CLAUDE.md`; manage Claude guidance yourself.

```toml
[profiles.default.instructions]
body = """
Always cite the file:line when referencing code.
Prefer ripgrep over find.
"""
```

## Yolo (skip-approvals) configuration

Every agent subcommand accepts `--yolo` to bypass approval prompts. The flag is translated per-agent: `--dangerously-skip-permissions` (claude), `--dangerously-bypass-approvals-and-sandbox` (codex), `--allow-all` (copilot), warning-only for `pi` (no equivalent).

Instead of typing `--yolo` every launch, set it once in `agent.toml`. Both `[defaults.yolo]` and `[profiles.<name>.yolo]` accept the same shape:

```toml
[defaults.yolo]
enabled = false           # baseline applied to every agent

[defaults.yolo.agents]
claude = true             # auto-skip prompts for claude everywhere

[profiles.solo.yolo]
enabled = true            # turn on for all agents under this profile
[profiles.solo.yolo.agents]
codex = false             # ...except codex, still prompts

[profiles.work.yolo.agents]
copilot = true            # only copilot is yolo in "work"
```

### Precedence (highest wins)

1. `--yolo` CLI flag
2. `COPILLM_YOLO` env var — **tri-state**: `1`/`true`/`yes` turns on, `0`/`false`/`no` explicitly turns off (overrides config), unset means "no opinion"
3. `profiles.<active>.yolo.agents.<id>`
4. `profiles.<active>.yolo.enabled`
5. `defaults.yolo.agents.<id>`
6. `defaults.yolo.enabled`
7. off

When yolo is enabled by config (not by the flag or env), copillm prints a one-line notice on stderr at launch so skipped approvals are never silent:

```
copillm: yolo enabled for claude via profile "solo" (enabled)
```

If a profile turns on yolo for `pi`, copillm forwards the args unchanged and warns — pi has no blanket-approve switch:

```
copillm: --yolo ignored for pi (pi has no blanket-approve flag; ...; source: profile enabled)
```

## Commands reference

| Command | What it does |
| ------- | ------------ |
| `copillm config init` | Scaffold `~/.copillm/agent.toml` |
| `copillm config show [--profile <name>]` | Print the resolved, env-expanded profile |
| `copillm config profile list` | List profiles (active marked with `*`) |
| `copillm config profile use <name>` | Set `active_profile` in global file |
| `copillm config sync --agent <kind> [--profile <name>]` | Sync to native/default agent paths without launching. `<kind>` ∈ `codex \| claude \| pi \| copilot` |

`copillm env <agent> [--profile <name>]` prints launch
environment/configuration details. External-provider `codex`, `pi`, and
`copilot` output does not require a running daemon.

## Troubleshooting

- **`Required env var "FOO" is not set and no default was provided in the agent.toml expansion.`** — export it, or add `${FOO:-default}` in your TOML.
- **`MCP server name "x" is not a valid TOML identifier; use only letters, digits, dashes, and underscores.`** — rename it to match `[A-Za-z0-9_-]+`.
- **`Codex config not found at …`** — run `copillm start` (or `copillm codex` once) so the base `config.toml` exists, then re-sync.
- **Nothing happens on launch** — neither `~/.copillm/agent.toml` nor `<cwd>/.copillm/agent.toml` exists. Run `copillm config init`.
