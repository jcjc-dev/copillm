# copillm

> **Unofficial proxy to make your Copilot CLI seat power everything.**

[![PR gate](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml/badge.svg?branch=main)](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml)
[![Release gate (nightly + on release)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml/badge.svg?branch=main&event=schedule)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml)

A local proxy that helps bring your GitHub Copilot CLI seat to its full potential by exposing OpenAI- and Anthropic-compatible HTTP endpoints backed by your existing Copilot subscription. A single login provides a unified gateway that Codex CLI, Claude Code, and other compatible tools can target directly.

> ⚠️ **Experimental / research tool.** Independent, unofficial client of GitHub Copilot's private API. Not affiliated with GitHub, Microsoft, OpenAI, or Anthropic. The upstream API can change without notice. Use at your own risk.

---

## Quick start

```bash
# 1. one-time login (GitHub device flow)
npx copillm login

# 2. launch your agent — copillm auto-starts the daemon, installs the agent if needed,
#    and wires up all env vars for you
npx copillm claude    # Claude Code, preconfigured
npx copillm codex     # Codex CLI, preconfigured
```

Requires Node.js 20 or later.

Extra args are forwarded straight to the underlying agent:

```bash
copillm claude --model opus
copillm codex --help
```

---

## Documentation

Full docs live at **[jcjc-dev.github.io/copillm](https://jcjc-dev.github.io/copillm/)**:

- **[Getting started](https://jcjc-dev.github.io/copillm/getting-started/)** — install, login, first run
- **[CLI reference](https://jcjc-dev.github.io/copillm/cli-reference/)** — every command and flag
- **[Using with Claude Code](https://jcjc-dev.github.io/copillm/claude-code/)** — env wiring, gateway discovery, the `[1m]` 1M-context alias
- **[Using with Codex CLI](https://jcjc-dev.github.io/copillm/codex/)** — env wiring, `config.toml` generation
- **[HTTP API reference](https://jcjc-dev.github.io/copillm/http-api/)** — endpoints, translation caveats
- **[Building from source & CI](https://jcjc-dev.github.io/copillm/development/)** — for contributors

---

## Contributing

Issues and PRs welcome — see the [development guide](https://jcjc-dev.github.io/copillm/development/).
