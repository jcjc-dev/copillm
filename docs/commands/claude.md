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

Any arguments after `claude` are forwarded verbatim to the underlying Claude Code CLI.

```bash
copillm claude --model opus
copillm claude --help
```

Use the global debug flag to debug copillm itself without stealing flags from Claude Code:

```bash
copillm --debug claude
copillm --debug claude -- --debug  # also forwards --debug to Claude Code
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
