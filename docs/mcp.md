---
title: MCP & agent.toml
layout: default
nav_order: 6
---

# MCP & `agent.toml`

copillm is a **MCP configuration aggregator**. You declare your MCP servers once in `~/.copillm/agent.toml`, and copillm fans them out to each coding agent's native config format on launch (`copillm claude`, `copillm codex`, `copillm pi`).

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

### Switching profiles

```bash
copillm config profile list      # show all profiles, * marks active
copillm config profile use work  # set active_profile in global agent.toml
copillm config sync --agent claude --profile work   # one-off override
```

The `--profile` flag on `sync` and `show` overrides `active_profile` for that invocation only.

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

- `copillm claude` writes a copillm-owned MCP file to `~/.copillm/claude/mcp.json` and appends `--mcp-config` for that launch. It also points Claude at a copillm-owned config home via `CLAUDE_CONFIG_DIR` (`~/.copillm/claude/home`), so the launch never reads or writes your real `~/.claude`.
- `copillm config sync --agent claude` writes MCP servers into user scope at `~/.claude.json` and writes copillm's provider env into `~/.claude/settings.json`.
- When the active profile declares no MCP servers, the managed file is removed and no `--mcp-config` flag is added.
- Instructions fan-out is **not supported** for Claude. Place project guidance in your own `CLAUDE.md` or global guidance in `~/.claude/CLAUDE.md`.

### Codex CLI

- `copillm codex` injects a `[mcp_servers]` TOML block into `~/.copillm/codex/config.toml` for the wrapped launch.
- `copillm config sync --agent codex` merges copillm's provider block into `~/.codex/config.toml` and injects the `[mcp_servers]` block there.
- The block is delimited with hash-comment markers so subsequent runs replace just the managed section.
- Requires `copillm start` (or any prior launch) to have generated the base `config.toml` first.

### pi

- copillm points pi at a copillm-owned agent dir via `PI_CODING_AGENT_DIR` (`~/.copillm/pi/agent`), so it never writes your real `~/.pi`. To launch `pi` directly (without copillm), export `PI_CODING_AGENT_DIR` to that path first.
- Writes a `copillm-mcp` extension into `~/.copillm/pi/agent/extensions/copillm-mcp/` (`servers.json` + `index.ts`).
- v1 lists servers via a `/copillm-mcp` slash command; full stdio/http transport wiring is deferred to a follow-up.

### Copilot CLI

- Currently a no-op stub. The native format is not yet publicly documented.

## Instructions block (bonus)

Same file also fans out instructions to each agent (AGENTS.md / pi prompt) inside a `<!-- copillm:managed begin/end -->` marker so the rest of those files stays yours. **Not supported for Claude** — copillm never writes to `CLAUDE.md`; manage that file yourself.

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

## Troubleshooting

- **`Required env var "FOO" is not set`** — export it, or add `${FOO:-default}` in your TOML.
- **`MCP server name "x" is not a valid TOML identifier`** — only `[A-Za-z0-9_-]+`. Rename it.
- **`Codex config not found at …`** — run `copillm start` (or `copillm codex` once) so the base `config.toml` exists, then re-sync.
- **Nothing happens on launch** — neither `~/.copillm/agent.toml` nor `<cwd>/.copillm/agent.toml` exists. Run `copillm config init`.
