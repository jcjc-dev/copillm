---
title: Environment variables
layout: default
parent: Commands
nav_order: 9
---

# Environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_PORT` | Override the daemon HTTP port. Default `4141`. |
| `COPILLM_LOG_LEVEL` | Override copillm's log level. `copillm --debug ...` sets this to `debug` for the daemon it starts. |
| `COPILLM_LOG_FILE` | Write daemon logs to a file. In detached debug mode the default is `~/.copillm/debug.log`; set this to choose another path. |
| `COPILLM_HOME` | Override copillm's home directory (default `~/.copillm`), where config, the credential-file fallback, the generated Codex config, and caches live. |
| `COPILLM_CLAUDE_VERSION` | Pin a specific Claude Code version used by `copillm claude`. |
| `COPILLM_CODEX_VERSION` | Pin a specific Codex CLI version used by `copillm codex`. |
| `COPILLM_COPILOT_VERSION` | Pin a specific GitHub Copilot CLI version used by `copillm copilot`. |
| `COPILLM_PI_VERSION` | Pin a specific pi version used by `copillm pi`. |
| `COPILLM_PROFILE` | Default `agent.toml` profile to use when `--profile` / `--copillm-profile` is not passed. |
| `COPILLM_ACCOUNT` | Account to route agent launches at when `--account` / `--copillm-account` is not passed (default: the default account). See [`copillm auth`](../auth/) and [account selection](../claude/#account-selection). |
| `COPILLM_YOLO` | Tri-state default for `--yolo`: `1`/`true`/`yes` enables, `0`/`false`/`no` disables (overrides `agent.toml`), unset defers to config. See [MCP & `agent.toml`](../../mcp/). |
| `COPILLM_USE_SYSTEM_AGENT` | Set to `1`/`true`/`yes` to let the agent launchers fall back to a matching binary on `PATH`. Off by default, so copillm runs the version it manages. |
| `COPILLM_UPDATE_CHECK` | Override the startup npm update check: `0`/`false`/`no`/`off` disables it, `1`/`true`/`yes`/`on` forces it on. Also disabled by `--no-update-notifier` or the standard `NO_UPDATE_NOTIFIER` env var. |
| `CODEX_HOME` | Set by copillm when it launches Codex, pointing Codex at the generated config under `~/.copillm/codex/` (it follows `COPILLM_HOME`). |
| `COPILLM_MAX_REQUEST_BYTES` | Maximum accepted request body size, in bytes. Default `33554432` (32 MiB). Oversized requests are rejected with HTTP `413 payload_too_large` — see the [HTTP API reference](../../http-api/#daemon-side-request-errors). |
| `ANTHROPIC_BASE_URL` | Set automatically by `copillm claude`. You normally do not set this yourself. |
