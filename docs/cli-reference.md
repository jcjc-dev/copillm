---
title: CLI reference
nav_order: 3
---

# CLI reference

All commands accept `--json` for machine-readable output.

## Auth

| Command | Description |
|---|---|
| `copillm auth login [--json]` | Canonical login via GitHub device flow. |
| `copillm auth logout [--json]` | Clear credentials and stop the daemon. |
| `copillm auth status [--json] [--no-user]` | Report stored credential state (`stored`, `backend`, `user`). When a credential is stored, fetches `https://api.github.com/user` to surface the GitHub login; pass `--no-user` (or rely on the graceful fallback when the network is unreachable) to skip the lookup. **Never prints the token.** Exits `0` if logged in, `2` if not, `1` on error. |
| `copillm login [--json]` | *Deprecated alias for `auth login`.* |
| `copillm logout [--json]` | *Deprecated alias for `auth logout`.* |

## Daemon

| Command | Description |
|---|---|
| `copillm start [--detach] [--json]` | Runs in the foreground by default. If you're not logged in, the foreground path prompts to log in interactively. The detached path fails fast with a clear message if not authenticated. |
| `copillm stop [--json]` | Stop the daemon. |
| `copillm status [--json]` | Daemon state + an `auth: { stored, backend }` block (token never included). |
| `copillm health [--json]` | Health probe. |

## Models

| Command | Description |
|---|---|
| `copillm models list [--json]` | Fetch live `/models` for the configured account type and snapshot to `~/.copillm/models.cache.json`. If upstream discovery is unreachable, falls back to the snapshot and prints a stale warning. |
| `copillm models select --models modelA,modelB [--json]` | Pin which models are advertised downstream. |

## Agents

| Command | Description |
|---|---|
| `copillm codex [-- ...args]` | Launch Codex CLI, preconfigured against copillm. |
| `copillm claude [-- ...args]` | Launch Claude Code, preconfigured against copillm. |
| `copillm env <codex\|claude> [--shell sh\|fish\|powershell] [--json] [--inline]` | Print the env block for manual wiring. See the [Claude Code](../claude-code/) and [Codex](../codex/) guides. |

## Agent launcher internals

`copillm codex` and `copillm claude` do everything in one shot:

1. **Auto-start the daemon** if it isn't already running (background mode).
2. **Resolve the agent binary** in this order:
   1. `--copillm-use <pkg>@<ver>` flag or `COPILLM_CODEX_VERSION` / `COPILLM_CLAUDE_VERSION` env var
   2. system `codex` / `claude` on `PATH`
   3. cached install at `~/.copillm/bin/<agent>/<version>/`
   4. fresh install via `npm install --prefix ~/.copillm/bin/<agent>/<version>/ <package>@<latest>`
3. **Print which path/version is being used** (e.g. `→ codex (system PATH, /usr/local/bin/codex, v1.4.7)` or `→ codex (cached, ~/.copillm/bin/codex/1.4.9/, v1.4.9)`).
4. **Forward all extra arguments** to the underlying agent (`copillm claude --model opus`, `copillm codex --help`, etc.).
5. **Inherit stdio** so the agent fully owns the TTY, and exit with the agent's exit code.

When a fresh install happens, the cache is staged into `~/.copillm/bin/<agent>/.staging-<ver>-<pid>/`, smoke-tested via `--version`, atomically renamed into place, and **all sibling versions are pruned** (we keep the latest only). Leftover staging directories older than one hour are also swept. A file lock at `~/.copillm/bin/<agent>/.lock` serializes concurrent invocations.

Because both upstream packages publish to npm, npm's standard `os` / `cpu` / `optionalDependencies` mechanism handles platform/arch resolution automatically (Codex's `@openai/codex` ships native binaries this way, like `esbuild` / `swc`; Claude Code is plain JS).

## Environment variables

| Variable | Purpose |
|---|---|
| `COPILLM_CODEX_VERSION` | Pin a specific Codex CLI version for `copillm codex`. |
| `COPILLM_CLAUDE_VERSION` | Pin a specific Claude Code version for `copillm claude`. |
| `COPILLM_PORT` | Override the daemon port (default `4141`). |
