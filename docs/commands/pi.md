---
title: pi
layout: default
parent: Commands
nav_order: 5
---

# `copillm pi`

Launch the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), fully wired against the local copillm daemon.

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

1. Starts the copillm daemon in the background if it is not already running.
2. Refreshes pi's copillm model list in copillm's own agent dir (`~/.copillm/pi/agent`, via `PI_CODING_AGENT_DIR`) so pi sees the live Copilot catalogue. copillm never writes your real `~/.pi`.
3. Resolves the pi binary in this order:
   1. `--copillm-use <pkg>@<ver>` flag or the `COPILLM_PI_VERSION` environment variable
   2. A cached install at `~/.copillm/bin/pi/<version>/`
   3. A fresh install of the latest `@earendil-works/pi-coding-agent` via `npm install` into `~/.copillm/bin/pi/<version>/`

   > **Opt-in PATH fallback.** Set `COPILLM_USE_SYSTEM_AGENT=1` (or `true`/`yes`) to additionally consider a system `pi` on `PATH` (checked before the cache when no version is pinned). Off by default so the version copillm runs is always the one it manages.
4. Injects the environment variables pi requires to talk to the local daemon.
5. Forwards stdin/stdout/stderr to the agent and exits with the agent's exit code.

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

The launch is validated up front: an unknown, malformed, or not-logged-in account fails fast with a clear error. pi's model list is also refreshed as the selected account, so its catalogue matches that account's entitlements. Under the hood pi is pointed at `http://127.0.0.1:4141/<account>/anthropic`; see [Selecting an account](../../http-api/#selecting-an-account) for the routing details.

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_PI_VERSION` | Pin a specific pi version. |
| `COPILLM_ACCOUNT` | Account to launch against when `--account` is not passed. See [Account selection](#account-selection). |
| `COPILLM_PROFILE` | Default profile selection used when `--copillm-profile` is not passed. |
| `COPILLM_PORT` | Override the daemon port (default `4141`). |
| `COPILLM_LOG_FILE` | Override the debug log path used when copillm auto-starts the daemon with `--debug`. |
