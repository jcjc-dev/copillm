---
title: codex
layout: default
parent: Commands
nav_order: 3
---

# `copillm codex`

Launch Codex CLI, fully wired against the local copillm daemon.

```bash
copillm [--debug] codex [args...]
```

Any arguments after `codex` are forwarded verbatim to the underlying Codex CLI — **except** for copillm-owned flags, which copillm consumes regardless of position.

```bash
copillm codex --model gpt-5
copillm codex --help
```

## Copillm-owned flags

Copillm reserves a small set of flags. Each has a long canonical form (`--copillm-*`) and a short alias. **Copillm consumes both forms before the agent sees them**, even if Codex would otherwise define the same short flag (e.g. Codex's own `--profile`).

| Short | Long (canonical) | Description |
| --- | --- | --- |
| `--profile <name>` | `--copillm-profile <name>` | Override the active profile from `~/.copillm/agent.toml` for this launch. |
| `--account <name>` | `--copillm-account <name>` | Route this launch at a specific copillm account (see [Account selection](#account-selection)). |
| `--use <spec>` | `--copillm-use <spec>` | Pin the Codex CLI version (e.g. `1.4.7` or `@openai/codex@1.4.7`). |
| `--debug` | `--copillm-debug` | Enable debug endpoints when auto-starting the daemon. |
| `--no-config` | `--copillm-no-config` | Skip `agent.toml` fan-out for this launch. |
| `--yolo` | — | Skip approvals/sandbox (injects `--dangerously-bypass-approvals-and-sandbox`). Reads `COPILLM_YOLO`. |

Examples:

```bash
copillm codex --profile work         # uses copillm profile "work"
copillm codex --yolo --debug         # yolo + copillm daemon diagnostics
copillm --debug codex                # equivalent (global debug flag still works)
```

## What it does

1. Starts the copillm daemon in the background if it is not already running.
2. Resolves the Codex CLI binary in this order:
   1. `--copillm-use <pkg>@<ver>` flag or the `COPILLM_CODEX_VERSION` environment variable
   2. A cached install at `~/.copillm/bin/codex/<version>/`
   3. A fresh install via `npm install --prefix ~/.copillm/bin/codex/<version>/ @openai/codex@latest`

   > **Opt-in PATH fallback.** Set `COPILLM_USE_SYSTEM_AGENT=1` to additionally consider a system `codex` on `PATH` (checked before the cache when no version is pinned). Off by default so the version copillm runs is always the one it manages.
3. Prints the resolved binary path and version, for example:
   ```text
   → codex (cached, ~/.copillm/bin/codex/1.4.9/, v1.4.9)
   ```
4. Generates `~/.copillm/codex/config.toml` (unless `CODEX_HOME` is overridden) so Codex points its model provider at `http://127.0.0.1:4141/codex`.
5. Forwards stdin/stdout/stderr to the agent and exits with the agent's exit code.

For details on Codex-specific configuration, see [Using with Codex CLI](../../codex/).

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

The launch is validated up front: an unknown, malformed, or not-logged-in account fails fast with a clear error. Model discovery for the generated Codex config runs as the selected account, so each account's catalogue is accurate. Under the hood Codex is pointed at `http://127.0.0.1:4141/<account>/codex/v1`; see [Selecting an account](../../http-api/#selecting-an-account) for the routing details.

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_CODEX_VERSION` | Pin a specific Codex CLI version. |
| `COPILLM_ACCOUNT` | Account to launch against when `--account` is not passed. See [Account selection](#account-selection). |
| `CODEX_HOME` | Override the directory used for Codex configuration. |
| `COPILLM_PORT` | Override the daemon port (default `4141`). |
| `COPILLM_LOG_FILE` | Override the debug log path used when copillm auto-starts the daemon with `--debug`. |
