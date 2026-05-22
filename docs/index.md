---
title: Home
layout: home
nav_order: 1
---

# copillm
{: .fs-9 }

Unofficial proxy to make your Copilot CLI seat power everything.
{: .fs-6 .fw-300 }

[Get started now](getting-started/){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/jcjc-dev/copillm){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What is copillm?

copillm is a local TypeScript daemon that exposes **OpenAI-compatible** and **Anthropic-compatible** HTTP endpoints, backed by your existing **GitHub Copilot** subscription.

That means any tool that speaks the OpenAI Chat Completions or Anthropic Messages wire format — Codex CLI, Claude Code, OpenAI SDK scripts, your own bots — can run against your Copilot seat with **zero extra API keys**.

## 30-second tour

```bash
npx copillm login    # one-time GitHub device-flow login
npx copillm claude   # launches Claude Code, fully wired
npx copillm codex    # launches Codex CLI, fully wired
```

copillm will:

1. Auto-start its background daemon on `http://127.0.0.1:4141`
2. Resolve (or install) the latest agent binary into `~/.copillm/bin/`
3. Inject the right env vars (`ANTHROPIC_BASE_URL`, `CODEX_HOME`, etc.)
4. Hand the TTY to the agent

## Why?

- **One subscription, every agent.** Stop juggling Anthropic, OpenAI, and Copilot API keys.
- **Local-first.** Everything runs on `127.0.0.1`. No third-party servers.
- **Drop-in.** Existing scripts that hit `api.openai.com` or `api.anthropic.com` work by changing the base URL.
- **Up-to-date models.** Live discovery against Copilot's `/models` — you get whatever Copilot ships, including 1M-context Claude variants.

## Where to next?

- **[Getting started](getting-started/)** — install, login, first run
- **[CLI reference](cli-reference/)** — every command and flag
- **[Using with Claude Code](claude-code/)** — env wiring + the `[1m]` 1M-context alias
- **[Using with Codex CLI](codex/)** — env wiring + auto-generated `config.toml`
- **[HTTP API reference](http-api/)** — endpoints, translation caveats
- **[Development & CI](development/)** — building from source, the PR/release gates

---

> ⚠️ **Experimental / research tool.** This project is an independent, unofficial client of GitHub Copilot's private API. It is not affiliated with, endorsed by, or supported by GitHub, Microsoft, OpenAI, or Anthropic. The upstream private API can change without notice and may stop working. Use at your own risk.
