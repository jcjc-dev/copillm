---
title: pi
layout: default
parent: Commands
nav_order: 5
---

# `copillm pi`

Launch the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), using pi's native GitHub Copilot provider by default. Set `COPILLM_PI_NATIVE_COPILOT=0` to opt into the legacy local copillm proxy path.

```bash
copillm [--debug] pi [args...]
```

Any arguments after `pi` are forwarded verbatim to the underlying pi CLI — **except** for copillm-owned flags, which copillm consumes regardless of position.

```bash
copillm pi --help
```

## Copillm-owned flags

Copillm reserves a small set of flags. Each has a long canonical form (`--copillm-*`) and a short alias. **Copillm consumes both forms before the agent sees them**, even if pi would otherwise define the same short flag.

| Short | Long (canonical) | Description |
| --- | --- | --- |
| `--profile <name>` | `--copillm-profile <name>` | Override the active profile from `~/.copillm/agent.toml` for this launch. |
| `--account <name>` | `--copillm-account <name>` | Route this launch at a specific copillm account (see [Account selection](#account-selection)). |
| `--use <spec>` | `--copillm-use <spec>` | Pin the pi version (e.g. `0.3.0` or `@earendil-works/pi-coding-agent@0.3.0`). |
| `--debug` | `--copillm-debug` | Enable debug endpoints when auto-starting the daemon. |
| `--no-config` | `--copillm-no-config` | Skip `agent.toml` fan-out for this launch. |
| `--yolo` | — | **No effect for pi.** pi has no blanket-approve switch, so copillm forwards your args unchanged and prints a one-line warning. Use pi's per-tool approvals instead. |

Examples:

```bash
copillm pi --profile work            # uses copillm profile "work"
copillm --debug pi                   # copillm daemon diagnostics
```

## What it does

When the active profile has no external provider, copillm uses native Copilot mode by default: it obtains a Copilot token, configures pi's built-in `github-copilot` provider for the account's API host, and does not start the copillm daemon. Pi's default model and thinking level can come from `[defaults.pi] model` and `thinking_level` in `~/.copillm/agent.toml`; copillm passes them as `--model` and `--thinking` defaults without editing Pi's `settings.json`. Explicit CLI options take precedence.

Set `COPILLM_PI_NATIVE_COPILOT=0` to use the retained legacy flow instead: it starts the daemon and refreshes pi's copillm proxy model catalogue. Other false-like values (`false`, `no`, `off`, or empty) also select the legacy flow.

Then copillm resolves the pi binary in this order:

1. `--copillm-use <pkg>@<ver>` flag or the `COPILLM_PI_VERSION` environment variable
2. A cached install at `~/.copillm/bin/pi/<version>/`, using the most recently checked version when available
3. Otherwise, a fresh install of the latest `@earendil-works/pi-coding-agent` into `~/.copillm/bin/pi/<version>/`

> **Opt-in PATH fallback.** Set `COPILLM_USE_SYSTEM_AGENT=1` (or `true`/`yes`) to additionally consider a system `pi` on `PATH` (checked before the cache when no version is pinned). Off by default so the version copillm runs is always the one it manages.

Version checks are cached for 24 hours. When a check is due and a cached version is available, copillm launches the newest cached install immediately and refreshes version information in the background. If a newer version is found, it is installed on a later launch. A first launch with no cached install still needs to check for and download a version. Finally, copillm injects pi's environment and forwards stdin/stdout/stderr to the agent.

When the active profile contains `[profiles.<name>.provider]`, copillm
instead writes a single external provider to pi's copillm-owned
`models.json`, does not start the daemon, and does not require a GitHub
credential. The provider's selected API, model, context/output limits,
reasoning setting, and compatibility options are applied to pi. The
credential is referenced by environment-variable name and is not written to
`models.json`.

For MCP fan-out into pi, see [MCP & `agent.toml`](../../mcp/#pi).

## Account selection

When you hold [more than one account](../auth/), this launch targets one of them. Precedence, highest first:

1. `--account <name>` / `--copillm-account <name>` on this command
2. the `COPILLM_ACCOUNT` environment variable
3. the active profile's [`account` pin](../../mcp/#pinning-an-account-to-a-profile) in `agent.toml`
4. the default account (what `copillm auth switch` sets)

copillm prints a one-line notice naming the account whenever one is chosen by flag, env, or profile:

```text
copillm: using account "work" (from --account)
```

The launch is validated up front: an unknown, malformed, or not-logged-in account fails fast with a clear error. Native mode uses that account's Copilot token and account-specific API host. In legacy mode (`COPILLM_PI_NATIVE_COPILOT=0`), pi's proxy model list is refreshed for that account and requests route through `http://127.0.0.1:4141/<account>/anthropic`; see [Selecting an account](../../http-api/#selecting-an-account) for the routing details.

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_PI_VERSION` | Pin a specific pi version. |
| `COPILLM_PI_NATIVE_COPILOT` | Native GitHub Copilot mode is the default; set to `0` to use the legacy local-proxy path. |
| `COPILLM_ACCOUNT` | Account to launch against when `--account` is not passed. See [Account selection](#account-selection). |
| `COPILLM_PROFILE` | Default profile selection used when `--copillm-profile` is not passed. |
| `PI_CODING_AGENT_DIR` | Explicitly override the pi config/session directory; this takes precedence over profile isolation. |
| `COPILLM_PORT` | Override the daemon port (default `4141`, used by the legacy proxy path). |
| `COPILLM_LOG_FILE` | Override the debug log path used when copillm auto-starts the daemon with `--debug`. |

Configure the default model and optional thinking level in `agent.toml` (the scaffold sets the model to `gpt-6-luna`):

```toml
[defaults.pi]
model = "gpt-6-luna"
thinking_level = "xhigh"
```

Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A profile can override either with `[profiles.<name>.pi]`. Explicit command-line `--model` / `--thinking` selections take precedence. The model must be available to your Copilot account and support the selected level.
