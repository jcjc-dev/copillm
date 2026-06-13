---
title: Home
layout: home
nav_order: 1
---

# copillm
{: .fs-9 }

A local proxy that brings Claude Code, Codex CLI, and other coding agents to your existing GitHub Copilot subscription.
{: .fs-6 .fw-300 }

[Get started](getting-started/){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/jcjc-dev/copillm){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What is copillm?

copillm is a local daemon that exposes **OpenAI-compatible** and **Anthropic-compatible** HTTP endpoints, backed by your existing **GitHub Copilot** subscription.

Any tool that speaks the OpenAI Chat Completions or Anthropic Messages wire format — Claude Code, Codex CLI, OpenAI SDK scripts, your own bots — can run against your Copilot seat without managing additional API keys.

## Getting started

```bash
npm install -g copillm   # or use `npx copillm ...` below

copillm auth login   # one-time GitHub device-flow login
copillm claude       # launches Claude Code, fully wired
copillm codex        # launches Codex CLI, fully wired
copillm copilot      # launches GitHub Copilot CLI with your stored token
copillm pi           # launches the pi coding agent, fully wired
```

copillm will:

1. Auto-start its background daemon on `http://127.0.0.1:4141`
2. Resolve (or install) the latest agent binary into `~/.copillm/bin/`
3. Inject the required environment variables (`ANTHROPIC_BASE_URL`, `CODEX_HOME`, etc.)
4. Hand the TTY to the agent

## Why copillm?

- **One subscription, every agent.** Run Claude Code, Codex CLI, and other compatible tools without managing separate Anthropic, OpenAI, and Copilot API keys.
- **Local-first.** All traffic stays on `127.0.0.1`; no third-party servers are involved.
- **Drop-in compatibility.** Existing scripts that target `api.openai.com` or `api.anthropic.com` work by changing the base URL.
- **Live model catalogue.** Models are discovered live from Copilot's `/models` endpoint, including 1M-context Claude variants.

## Documentation

- **[Getting started](getting-started/)** — installation, authentication, first run
- **[Commands](commands/)** — every command, grouped by domain (`auth`, `claude`, `codex`, `copilot`, `pi`, `daemon`, `env`, `models`, `config`)
- **[Using with Claude Code](claude-code/)** — environment wiring and the `[1m]` 1M-context alias
- **[Using with Codex CLI](codex/)** — environment wiring and `config.toml` generation
- **[MCP & `agent.toml`](mcp/)** — declare MCP servers once, fan out to every agent
- **[HTTP API reference](http-api/)** — endpoints and translation behaviour
- **[Development & CI](development/)** — building from source, PR gate, upstream e2e, release pipeline

---

> **Disclaimer.** copillm is an independent, unofficial client of GitHub Copilot's private API. It is not affiliated with, endorsed by, or supported by GitHub, Microsoft, OpenAI, or Anthropic. The upstream API may change at any time without notice. Use this project at your own risk.
