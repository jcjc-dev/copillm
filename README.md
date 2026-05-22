# copillm

[![PR gate](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml/badge.svg?branch=main)](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml)
[![Release gate (nightly + on release)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml/badge.svg?branch=main&event=schedule)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml)

TypeScript CLI that exposes local OpenAI-compatible and Anthropic-compatible endpoints backed by GitHub Copilot.

> **Experimental / research tool.** This project is an independent, unofficial client of GitHub Copilot's private API. It is not affiliated with, endorsed by, or supported by GitHub, Microsoft, OpenAI, or Anthropic.
>
> Use is at your own risk. The upstream private API can change without notice and may stop working.

## Run with npx

```bash
npx copillm login
npx copillm start
```

`npx` requires Node.js (>=20). No global install is required. For repeatable automation, pin a version (for example `npx copillm@0.1.0 ...`).

## Release packaging

### npm / npx package

```bash
npm run build
```

- `prepack` runs `npm run build`, so published npm tarballs include `dist/cli.js` for `npx`.

## Commands

- `copillm auth login [--json]` — canonical login via GitHub device flow
- `copillm auth logout [--json]` — clear credentials and stop the daemon
- `copillm auth status [--json] [--no-user]` — report whether a credential is stored (`stored: true|false`, `backend: keytar|file|session|null`, `user: {login, name}|null`). When a credential is stored, fetches `https://api.github.com/user` to surface the GitHub login behind it; pass `--no-user` (or rely on the graceful fallback when the network is unreachable) to skip the lookup. **Never prints the token.** Exits 0 if logged in, 2 if not, 1 on error.
- `copillm login [--json]` — *(deprecated alias for `auth login`)*
- `copillm logout [--json]` — *(deprecated alias for `auth logout`)*
- `copillm start [--detach] [--json]` — runs in the foreground by default. If you're not logged in, the foreground path prompts to log in interactively. The detached path fails fast with a clear message if not authenticated.
- `copillm stop [--json]`
- `copillm status [--json]` — daemon state + an `auth: { stored, backend }` block (token never included)
- `copillm health [--json]`
- `copillm models list [--json]`
- `copillm models select --models modelA,modelB [--json]`
- `copillm env <codex|claude> [--shell sh|fish|powershell] [--json] [--inline]`
- `copillm codex [-- ...args]`  &nbsp;&nbsp;# launches Codex CLI, preconfigured
- `copillm claude [-- ...args]` &nbsp;&nbsp;# launches Claude Code, preconfigured

`models list` fetches live `/models` for the configured account type and saves a snapshot at `~/.copillm/models.cache.json`. If upstream discovery is unreachable, it falls back to that snapshot and prints a stale warning.

## Launching agents (the easy way)

Once you have run `copillm login` once, just run one of:

```bash
copillm codex      # launches Codex CLI against copillm
copillm claude     # launches Claude Code against copillm
```

These subcommands do everything for you:

1. **Auto-start the daemon** if it isn't already running (background mode).
2. **Resolve the agent binary** in this order:
   1. `--copillm-use <pkg>@<ver>` flag or `COPILLM_CODEX_VERSION` / `COPILLM_CLAUDE_VERSION` env var,
   2. system `codex` / `claude` on `PATH`,
   3. cached install at `~/.copillm/bin/<agent>/<version>/`,
   4. fresh install via `npm install --prefix ~/.copillm/bin/<agent>/<version>/ <package>@<latest>`.
3. **Print which path/version is being used** (e.g. `→ codex (system PATH, /usr/local/bin/codex, v1.4.7)` or `→ codex (cached, ~/.copillm/bin/codex/1.4.9/, v1.4.9)`).
4. **Forward all extra arguments** to the underlying agent (`copillm claude --model opus`, `copillm codex --help`, etc.).
5. **Inherit stdio** so the agent fully owns the TTY, and exit with the agent's exit code.

When a fresh install happens, the cache is staged into `~/.copillm/bin/<agent>/.staging-<ver>-<pid>/`, smoke-tested via `--version`, atomically renamed into place, and **all sibling versions are pruned** (we keep the latest only). Any leftover staging directories older than one hour are also swept. A small file lock at `~/.copillm/bin/<agent>/.lock` serializes concurrent invocations during install.

Because both upstream packages publish to npm, npm's standard `os` / `cpu` / `optionalDependencies` mechanism handles platform/arch resolution automatically (Codex's `@openai/codex` ships native binaries this way, like `esbuild` / `swc`; Claude Code is plain JS).

## Using with Codex CLI (manual)

If you would rather wire it up yourself, `copillm env codex` prints the env block:

```bash
$ copillm env codex
# Codex CLI → copillm
export CODEX_HOME="/Users/you/.copillm/codex"
```

`copillm start` already generates `~/.copillm/codex/config.toml` with the right `[model_providers]` block for live discovery against the local proxy. `--shell fish` and `--shell powershell` are also supported, and `--json` returns a machine-readable payload.

## Using with Claude Code (manual)

`copillm env claude` prints the matching block. It auto-detects the latest plain (non-`-high` / `-xhigh` / `-internal`) variant per family from your live Copilot model list, pins them to the matching Claude Code alias env vars, and enables gateway discovery:

```bash
$ copillm env claude
# Claude Code → copillm
export ANTHROPIC_BASE_URL="http://127.0.0.1:4141/anthropic"
export ANTHROPIC_AUTH_TOKEN="copillm-local"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4.7"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4.6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4.5"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
```

Paste it into a shell, or `eval "$(copillm env claude)"` to load it into the current shell, then run `claude`. Use `copillm env claude --inline` to get the legacy single-line form.

What each piece does:

- `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` — point Claude Code at the local copillm proxy
- `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` — Claude Code resolves the `opus`/`sonnet`/`haiku` aliases (used by `/model` selections, `claude --model opus`, and background haiku-class tasks) to these specific Copilot variants client-side
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` — Claude Code v2.1.129+ calls our `/anthropic/v1/models` endpoint at startup and populates the `/model` picker with every claude-prefixed Copilot variant. Each appears labelled "From gateway"

Override any env var in your shell (e.g. `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4.7-high`) to pick a different Copilot variant. copillm doesn't touch `~/.claude/settings.json` or persist any Anthropic preferences.

### Context windows and the `[1m]` alias

Each Copilot model carries three distinct token limits in its upstream metadata:

- `max_prompt_tokens` — hard ceiling on input tokens in a SINGLE API call, enforced by Copilot server-side.
- `max_output_tokens` — hard ceiling on output tokens in a single call.
- `max_context_window_tokens` — total conversation budget across turns (input + output + cache reads).

Claude Code's `/anthropic/v1/models` gateway-discovery validator only reads `id` and `display_name` per model — there is no field through which copillm can communicate a numeric context window. Without recognising the model id, Claude Code falls back to a hardcoded **200K per-model max** for autocompact purposes, regardless of `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or the `autoCompactWindow` setting (which can only *reduce* the cap, never raise it).

The only client-side marker Claude Code recognises is a literal `[1m]` suffix on the model id (its binary matches `id.toLowerCase().includes("opus") && id.toLowerCase().includes("[1m]")` for opus; the sonnet matcher requires a contiguous `sonnet[1m]` substring that copillm-aliased ids don't form; no non-Claude vendor has any `[1m]` matcher). So when copillm sees an **opus** upstream model with `max_context_window_tokens >= 1_000_000`, it advertises the id with `[1m]` appended in the `/anthropic/v1/models` response and **strips the suffix back off** before forwarding any request to Copilot. Net effect:

- The `/model` picker entry for the model carries the `[1m]` suffix
- Claude Code allocates a 1M-class autocompact budget (`effectiveWindow ≈ 980_000`)
- Upstream still receives the canonical model id
- Per-request input is still bounded server-side at the model's `max_prompt_tokens` — well above the typical fresh delta sent on any single turn thanks to prompt caching

Models with `max_context_window_tokens` between 200K and 1M, and non-opus models even when they exceed 1M, get no alias: Claude Code has no marker for intermediate tiers, and its 1M matcher is restricted to opus ids in practice.

## Local HTTP endpoints

- `GET /models` (enumerate eligible models + discovery metadata)
- `GET /v1/models` (OpenAI-style alias for model discovery)
- `GET /codex/v1/models`
- `GET /anthropic/v1/models` (Anthropic spec; consumed by Claude Code gateway discovery)
- `GET /healthz`
- `GET /livez`
- `POST /codex/v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/messages` (Anthropic-compatible)
- `POST /anthropic/v1/messages` (Anthropic-compatible)

## Translation caveats (current behavior)

- OpenAI-to-Anthropic content-part translation supports text parts only.
- Anthropic `tool_result` blocks with `is_error: true` are translated into the OpenAI `tool` role (which has no `is_error` field) with the content prefixed by `[tool_error] ` so the assistant still sees that the tool failed. This lets coding agents recover from tool failures (e.g. a failed `Bash` invocation or MCP tool error) instead of the whole conversation 400ing.
- Model ids advertised on `/anthropic/v1/models` may carry a `[1m]` suffix when the upstream model reports `max_context_window_tokens >= 1_000_000`. The suffix is stripped back off before any request is forwarded upstream, so canonical model ids are always what Copilot sees. See "Context windows and the `[1m]` alias" above for the why.

## CI: PR gate, release gate, and nightly schedule

[![PR gate](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml/badge.svg?branch=main)](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml)
[![Release gate (nightly + on release)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml/badge.svg?branch=main&event=schedule)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml)

Two workflows, both running a `ubuntu-latest` × `macos-latest` × `windows-latest` matrix on Node 20 and 22:

| Workflow | Triggers | What it runs |
|---|---|---|
| **PR gate** (`pr-gate.yml`) | every PR + push to `main` + manual | lint + build + unit tests (`vitest`) + E2E PR-gate runner (mock backend + synthetic Codex/Claude clients hitting copillm with the real wire format and SSE shapes) |
| **Release gate** (`release-gate.yml`) | on `release.published` + nightly cron at 09:00 UTC + manual | everything in PR gate + E2E release runner that installs the latest [`@openai/codex`](https://www.npmjs.com/package/@openai/codex) and [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) via `npx -y` and drives them through the mock-backed copillm stack |

The nightly schedule on the release gate gives daily signal on whether copillm still works against the latest published Codex/Claude Code releases — useful for catching upstream wire-format regressions without waiting for someone to cut a copillm release.

The release-gate workflow accepts `workflow_dispatch` inputs to pin specific package versions:

- `codex_package` (default `@openai/codex@latest`)
- `claude_package` (default `@anthropic-ai/claude-code@latest`)

Run locally:

```bash
npm run test:e2e:pr        # synthetic clients, no external installs
npm run test:e2e:release   # installs latest Codex + Claude Code
```

The mock backend (`tests/mock-backend/`) serves a fictional model catalog (`claude-test-opus`, `claude-test-sonnet`, `claude-test-haiku`, `gpt-test`, `gpt-test-codex`) so tests are hermetic and require no GitHub or Copilot credentials.
