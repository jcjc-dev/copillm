---
title: daemon
layout: default
parent: Commands
nav_order: 4
---

# Daemon commands

The copillm daemon is a local HTTP proxy that exposes OpenAI- and Anthropic-compatible endpoints on `http://127.0.0.1:4141`. The `copillm claude` and `copillm codex` launchers manage the daemon automatically; the commands below are for manual control and inspection.

## `copillm start`

Start the daemon. Runs in the foreground by default and prompts for interactive login when no credential is stored.

```bash
copillm start [--detach] [--json]
```

| Flag | Description |
| --- | --- |
| `--detach` | Run the daemon as a background process. Fails fast with a clear message if no credential is stored. |
| `--json` | Emit a JSON result instead of human output. |

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
copillm status [--json]
```

## `copillm health`

Probe the daemon's `/health` endpoint and report the result. Useful in scripts that need to confirm the daemon is reachable before issuing requests.

```bash
copillm health [--json]
```

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_PORT` | Override the daemon port (default `4141`). |
