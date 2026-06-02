---
title: claude
layout: default
parent: Commands
nav_order: 2
---

# `copillm claude`

Launch Claude Code, fully wired against the local copillm daemon.

```bash
copillm [--debug] claude [args...]
```

Any arguments after `claude` are forwarded verbatim to the underlying Claude Code CLI — **except** for copillm-owned flags, which copillm consumes regardless of position.

```bash
copillm claude --model opus
copillm claude --help
```

## Copillm-owned flags

Copillm reserves a small set of flags. Each has a long canonical form (`--copillm-*`) and a short alias. **Copillm consumes both forms before the agent sees them**, even if Claude Code would otherwise define the same short flag.

| Short | Long (canonical) | Description |
| --- | --- | --- |
| `--profile <name>` | `--copillm-profile <name>` | Override the active profile from `~/.copillm/agent.toml` for this launch. |
| `--use <spec>` | `--copillm-use <spec>` | Pin the Claude Code version (e.g. `2.1.0` or `@anthropic-ai/claude-code@2.1.0`). |
| `--debug` | `--copillm-debug` | Enable debug endpoints when auto-starting the daemon. |
| `--no-config` | `--copillm-no-config` | Skip `agent.toml` fan-out for this launch. |
| `--yolo` | — | Skip permission prompts (injects `--dangerously-skip-permissions`). Reads `COPILLM_YOLO`. |

Examples:

```bash
copillm claude --profile work        # uses copillm profile "work"
copillm claude --yolo --debug        # yolo + copillm daemon diagnostics
copillm --debug claude               # equivalent (global debug flag still works)
```

## What it does

1. Starts the copillm daemon in the background if it is not already running.
2. Resolves the Claude Code binary in this order:
   1. `--copillm-use <pkg>@<ver>` flag or the `COPILLM_CLAUDE_VERSION` environment variable
   2. A system `claude` executable on `PATH`
   3. A cached install at `~/.copillm/bin/claude/<version>/`
   4. A fresh install via `npm install --prefix ~/.copillm/bin/claude/<version>/ @anthropic-ai/claude-code@latest`
3. Prints the resolved binary path and version, for example:
   ```text
   → claude (cached, ~/.copillm/bin/claude/2.1.0/, v2.1.0)
   ```
4. Injects the environment variables Claude Code requires (`ANTHROPIC_BASE_URL`, the auth header, and related configuration).
5. Forwards stdin/stdout/stderr to the agent and exits with the agent's exit code.

For details on Claude-specific environment wiring and the `[1m]` 1M-context model alias, see [Using with Claude Code](../../claude-code/).

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_CLAUDE_VERSION` | Pin a specific Claude Code version. |
| `COPILLM_PORT` | Override the daemon port (default `4141`). |
| `COPILLM_LOG_FILE` | Override the debug log path used when copillm auto-starts the daemon with `--debug`. |
