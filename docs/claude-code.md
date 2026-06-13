---
title: Using with Claude Code
layout: default
nav_order: 4
---

# Using with Claude Code

## The easy way

```bash
copillm claude
```

That handles login check, daemon start, agent install/resolve, and env wiring. Done.

## Manual wiring

If you'd rather drive `claude` yourself, `copillm env claude` prints the matching env block. It auto-detects the latest plain (non-`-high` / `-xhigh` / `-internal`) variant per family from your live Copilot model list, pins them to the matching Claude Code alias env vars, and enables gateway discovery:

```bash
$ copillm env claude
# Claude Code → copillm
export ANTHROPIC_BASE_URL="http://127.0.0.1:4141/anthropic"
export ANTHROPIC_AUTH_TOKEN="copillm-local"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4.7"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4.6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4.5"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
export CLAUDE_CONFIG_DIR="$HOME/.copillm/claude/home"
```

Paste it into a shell, or `eval "$(copillm env claude)"` to load it into the current shell, then run `claude`. Use `copillm env claude --inline` for the legacy single-line form. `--shell fish` and `--shell powershell` are also supported.

To persist the same provider wiring into Claude Code's native settings without launching through copillm, run:

```bash
copillm config sync --agent claude
```

That writes the provider environment into `~/.claude/settings.json` and syncs the active profile's MCP servers into user scope in `~/.claude.json`.

### What each piece does

- `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` — point Claude Code at the local copillm proxy
- `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` — Claude Code resolves the `opus`/`sonnet`/`haiku` aliases (used by `/model` selections, `claude --model opus`, and background haiku-class tasks) to these specific Copilot variants client-side
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` — Claude Code v2.1.129+ calls our `/anthropic/v1/models` endpoint at startup and populates the `/model` picker with every Copilot model you're entitled to that supports chat — not just Claude-branded ones, so Gemini and GPT variants appear too. Each appears labelled "From gateway"
- `CLAUDE_CONFIG_DIR` — points Claude at a copillm-owned config home (`~/.copillm/claude/home`) instead of your real `~/.claude`. This keeps copillm-launched Claude deterministic and isolated (so dev and prod instances never collide), but it means your personal `~/.claude` settings, `CLAUDE.md`, and subagents do **not** apply to `copillm claude`. Run `copillm config sync --agent claude` if you want copillm's wiring in your real `~/.claude` for a direct `claude` launch.

Override any env var in your shell (e.g. `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4.7-high`) to pick a different Copilot variant. The `copillm claude` launcher does not persist Anthropic preferences; only `copillm config sync --agent claude` writes native Claude settings.

## Context windows and the `[1m]` alias

Each Copilot model carries three distinct token limits in its upstream metadata:

- `max_prompt_tokens` — hard ceiling on input tokens in a SINGLE API call, enforced by Copilot server-side
- `max_output_tokens` — hard ceiling on output tokens in a single call
- `max_context_window_tokens` — total conversation budget across turns (input + output + cache reads)

Claude Code's `/anthropic/v1/models` gateway-discovery validator only reads `id` and `display_name` per model — there is no field through which copillm can communicate a numeric context window. Without recognising the model id, Claude Code falls back to a hardcoded **200K per-model max** for autocompact purposes, regardless of `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or the `autoCompactWindow` setting (which can only *reduce* the cap, never raise it).

The only client-side marker Claude Code recognises is a literal `[1m]` suffix on the model id (its binary matches `id.toLowerCase().includes("opus") && id.toLowerCase().includes("[1m]")` for opus; the sonnet matcher requires a contiguous `sonnet[1m]` substring that copillm-aliased ids don't form; no non-Claude vendor has any `[1m]` matcher). So when copillm sees an **opus** upstream model with `max_context_window_tokens >= 1_000_000`, it advertises the id with `[1m]` appended in the `/anthropic/v1/models` response and **strips the suffix back off** before forwarding any request to Copilot. Net effect:

- The `/model` picker entry for the model carries the `[1m]` suffix
- Claude Code allocates a 1M-class autocompact budget (`effectiveWindow ≈ 980_000`)
- Upstream still receives the canonical model id
- Per-request input is still bounded server-side at the model's `max_prompt_tokens` — well above the typical fresh delta sent on any single turn thanks to prompt caching

Models with `max_context_window_tokens` between 200K and 1M, and non-opus models even when they exceed 1M, get no alias: Claude Code has no marker for intermediate tiers, and its 1M matcher is restricted to opus ids in practice.
