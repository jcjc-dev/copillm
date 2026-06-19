---
title: daemon
layout: default
parent: Commands
nav_order: 6
---

# Daemon commands

The copillm daemon is a local HTTP proxy that exposes OpenAI- and Anthropic-compatible endpoints on `http://127.0.0.1:4141`. The `copillm claude`, `copillm codex`, and `copillm pi` launchers manage the daemon automatically; the commands below are for manual control and inspection.

## `copillm start`

Start the daemon. Runs in the foreground by default and prompts for interactive login when no credential is stored.

```bash
copillm [--debug] start [--detach] [--debug] [--json]
```

| Flag | Description |
| --- | --- |
| `--detach` | Run the daemon as a background process. Fails fast with a clear message if no credential is stored. |
| `--debug` | Compatibility alias for global `copillm --debug start`. Enables `/_debug`, debug-level daemon diagnostics, and (with `--detach`) writes logs to `~/.copillm/debug.log`. |
| `--json` | Emit a JSON result instead of human output. |

Prefer the global form for consistency:

```bash
copillm --debug start --detach
```

If a daemon is already running without debug mode, `copillm start` will not change its diagnostics. Use [`copillm restart --debug`](#copillm-restart) (or `copillm stop` then `copillm --debug start`) to bring it back up with debug enabled.

## `copillm restart`

Restart the running daemon, bringing it back up in the background on the **same port and debug mode it is currently running on**. Handy after rotating credentials, or to recover a wedged daemon without having to remember how it was originally started.

```bash
copillm [--debug] restart [--json]
```

| Flag | Description |
| --- | --- |
| `--debug` | Force debug mode on for the restarted daemon, even if it was running without it. |
| `--json` | Emit a JSON result instead of human output. |

The restarted daemon keeps the port it was already serving and preserves its current debug mode automatically — pass `--debug` only when you want to turn diagnostics on. Like [`copillm stop`](#copillm-stop), a restart clears the Claude Code gateway model cache. If no daemon is running, `restart` just starts one with default settings.

When copillm was installed globally with npm, `restart` also updates copillm to the latest published version before bringing the daemon back up, so the restarted daemon runs the newest code. This is best-effort: if the registry can't be reached or the install isn't permitted, the restart simply proceeds on the version you already have and prints a short note. It is skipped automatically when you're running a local or development build. The `--json` payload reports the outcome under a `self_update` field.

## `copillm stop`

Stop the running daemon.

```bash
copillm stop [--json]
```

| Flag | Description |
| --- | --- |
| `--json` | Emit a JSON result instead of human output. |

## `copillm status`

Report whether the daemon is running, along with an `auth: { stored, backend }` block. The credential token is never included.

```bash
copillm status [--json] [--no-registry-check]
```

A `home:` line leads the output, showing which copillm home the daemon uses, with a `(dev)` marker under [`--dev`](../../development/#isolated-dev-mode-run-dev--prod-side-by-side):

```text
home: ~/.copillm-dev (dev)
```

A `version:` line reports the running version. In the common case the daemon and CLI agree and it is just `version: 0.4.5`. When the daemon and CLI versions differ, the CLI version is shown in parentheses; in either that case or when a newer release is on npm, an inline hint (after an em-dash) tells you what to do:

```text
version: 0.4.5 (cli 0.4.6) — restart to apply cli v0.4.6
version: 0.4.5 — newer version available: v0.4.6 (npm install -g copillm)
```

The `--json` payload exposes this as `cli_version`, `daemon_version` (`null` when stopped), `latest_version` (best-effort; `null` if the npm lookup is skipped or fails), `update_available`, `version_hint`, plus the `copillm_home` and `dev_mode` fields behind the `home:` line. Pass `--no-registry-check` (or set `COPILLM_UPDATE_CHECK=0` / `NO_UPDATE_NOTIFIER`) to skip the registry lookup.

When the daemon is running, the output also includes an `uptime` line showing how long it has been up, broken down into days, hours, minutes, and seconds (e.g. `uptime: 2d 3h 15m 9s (184509s)`). The `--json` payload carries both the raw `uptime_seconds` and the human-readable `uptime_human` string.

## `copillm health`

Probe the daemon's `/health` endpoint and report the result. Useful in scripts that need to confirm the daemon is reachable before issuing requests.

```bash
copillm health [--json]
```

## Troubleshooting

**Upstream errors reach the agent verbatim.** When Copilot upstream returns a non-2xx response (rate limit, auth failure, server error), the daemon forwards the upstream HTTP status code and a sanitized error body to the calling agent instead of masking it as a generic proxy error. If your coding agent prints `upstream_rate_limited` / `upstream_auth_error` / `upstream_server_error`, the problem is on the Copilot side, not the daemon. See the [HTTP API error handling reference](../../http-api/#error-handling) for the response shape and the full category list.

A generic `proxy_error` (HTTP `502`) means the daemon itself failed to talk to upstream — usually a transport-level issue. Re-run with `copillm --debug start` to capture the upstream interaction in `~/.copillm/debug.log`.

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_PORT` | Override the daemon port (default `4141`). |
| `COPILLM_LOG_LEVEL` | Override daemon log level (`debug`, `info`, `warn`, etc.). |
| `COPILLM_LOG_FILE` | Write daemon logs to a specific file. `copillm --debug start --detach` defaults this to `~/.copillm/debug.log`. |
