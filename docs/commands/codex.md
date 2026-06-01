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
   2. A system `codex` executable on `PATH`
   3. A cached install at `~/.copillm/bin/codex/<version>/`
   4. A fresh install via `npm install --prefix ~/.copillm/bin/codex/<version>/ @openai/codex@latest`
3. Prints the resolved binary path and version, for example:
   ```text
   → codex (cached, ~/.copillm/bin/codex/1.4.9/, v1.4.9)
   ```
4. Generates `~/.copillm/codex/config.toml` (unless `CODEX_HOME` is overridden) so Codex points its model provider at `http://127.0.0.1:4141/codex`.
5. Forwards stdin/stdout/stderr to the agent and exits with the agent's exit code.

For details on Codex-specific configuration, see [Using with Codex CLI](../../codex/).

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_CODEX_VERSION` | Pin a specific Codex CLI version. |
| `CODEX_HOME` | Override the directory used for Codex configuration. |
| `COPILLM_PORT` | Override the daemon port (default `4141`). |
| `COPILLM_LOG_FILE` | Override the debug log path used when copillm auto-starts the daemon with `--debug`. |
