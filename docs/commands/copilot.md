---
title: copilot
layout: default
parent: Commands
nav_order: 4
---

# `copillm copilot`

Launch GitHub Copilot CLI using either copillm's stored GitHub OAuth token or
an external provider configured in the active profile.

```bash
copillm copilot [args...]
```

Any arguments after `copilot` other than copillm's own flags are forwarded to the underlying Copilot CLI:

```bash
copillm copilot --help
copillm copilot suggest -t shell "list large files"
```

## Copillm-backed launch

When the active profile has no external provider:

1. Reads the stored GitHub credential. If none is present, exits non-zero with `copillm: no stored GitHub credential — run `copillm auth login` first.`
2. Resolves the Copilot CLI binary in the same order as the other agent launchers — pinned `--copillm-use`/`COPILLM_COPILOT_VERSION`, then a cached install at `~/.copillm/bin/copilot/<version>/`, then a fresh `npm install` of `@github/copilot`. Set `COPILLM_USE_SYSTEM_AGENT=1` (or `true`/`yes`) to also consider a system `copilot` on `PATH` (checked before the cache when no version is pinned; off by default).
3. Spawns the Copilot CLI with `COPILOT_GITHUB_TOKEN` injected into the child environment only. Copilot CLI honours this variable ahead of its own stored credentials, which short-circuits its device-flow login.
4. Forwards stdin/stdout/stderr to the agent and exits with the agent's exit code.

> **Note:** Unlike `copillm claude` and `copillm codex`, this launcher does **not** start the local proxy daemon. In this mode copillm acts purely as a credential broker for Copilot CLI.

## External provider launch

When the active profile contains `[profiles.<name>.provider]`, copillm skips
GitHub credential lookup and launches Copilot CLI with the provider's base URL,
type, model, and credential. The endpoint must support streaming and tool
calls. An Anthropic provider uses its native message protocol; OpenAI/Azure
providers use their OpenAI-compatible interface.

The credential value is read from the environment at launch and passed only to
the child process. It is never stored in `agent.toml` or the generated MCP
configuration. Use `copillm env copilot` for a shell block that references the
credential variable without printing its value.

## Flags

Copillm reserves a small set of flags. Each has a long canonical form (`--copillm-*`) and a short alias. **Copillm consumes both forms before the agent sees them**, even if Copilot CLI would otherwise define the same short flag.

| Short | Long (canonical) | Description |
| --- | --- | --- |
| `--profile <name>` | `--copillm-profile <name>` | Override the active profile from `~/.copillm/agent.toml` for this launch. |
| `--account <name>` | `--copillm-account <name>` | Use a specific copillm account's GitHub token for this launch (see [Account selection](#account-selection)). |
| `--use <spec>` | `--copillm-use <spec>` | Pin the Copilot CLI package version (e.g. `1.0.52` or `@github/copilot@1.0.52`). |
| `--no-config` | `--copillm-no-config` | Skip `agent.toml` fan-out for this launch. |
| `--yolo` | — | Allow all tools, paths, and URLs (injects `--allow-all`). Also reads `COPILLM_YOLO` — see [agent.toml docs](../../mcp/) for the tri-state precedence. |

Any other flags are forwarded to the Copilot CLI.

## Account selection

When you hold [more than one account](../auth/), `--account <name>` (alias `--copillm-account <name>`) selects which account's stored GitHub token is injected for this launch. Precedence, highest first: `--account`, then `COPILLM_ACCOUNT`, then the active profile's [`account` pin](../../mcp/#pinning-an-account-to-a-profile), then the default account.

Unlike the other launchers, `copillm copilot` does **not** start the proxy daemon or use a `/<account>` URL prefix — it is a pure credential broker, so account selection here just picks which GitHub token Copilot CLI runs with. An unknown or not-logged-in account fails fast with a clear error.

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_COPILOT_VERSION` | Pin a specific Copilot CLI version. |
| `COPILLM_ACCOUNT` | Account whose GitHub token to use when `--account` is not passed. See [Account selection](#account-selection). |
| `COPILLM_PROFILE` | Default profile selection used when `--copillm-profile` is not passed. |
| `COPILLM_YOLO` | Tri-state default for `--yolo` (`1`/`true`/`yes` → enable; `0`/`false`/`no` → disable; unset → inherit `agent.toml`). |
| `COPILOT_HOME` | Explicitly override Copilot CLI's config/session directory; this takes precedence over profile isolation. In shared mode copillm does not set this variable. |
