---
title: Environment variables
layout: default
parent: Commands
nav_order: 7
---

# Environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_PORT` | Override the daemon HTTP port. Default `4141`. |
| `COPILLM_CODEX_VERSION` | Pin a specific Codex CLI version used by `copillm codex`. |
| `COPILLM_CLAUDE_VERSION` | Pin a specific Claude Code version used by `copillm claude`. |
| `CODEX_HOME` | Override the directory where Codex looks for its configuration file. When unset, copillm writes `~/.copillm/codex/config.toml`. |
| `ANTHROPIC_BASE_URL` | Set automatically by `copillm claude`. You normally do not set this yourself. |
