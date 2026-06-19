---
title: Getting started
layout: default
nav_order: 2
---

# Getting started

## Requirements

- Node.js ≥ 20
- A GitHub account with an active **Copilot subscription** (Individual, Business, or Enterprise — Pro+ tier required for Claude/GPT model access)

## Installation

Install globally from [npm](https://www.npmjs.com/package/copillm) for the most convenient usage:

```bash
npm install -g copillm
```

Or invoke it on demand with `npx` (no global install needed). For repeatable automation, pin a version (e.g. `npx copillm@0.1.0 ...`).

## 1. Log in

```bash
copillm auth login
```

This kicks off GitHub's device-flow OAuth — you'll see a code to paste into `github.com/login/device`. The resulting token is stored in your OS keychain when available, otherwise in `~/.copillm/credentials.json` with 0600 perms.

Verify with:

```bash
copillm auth status
# logged in as @your-handle (Your Name) (OS keychain)
```

The token is **never** printed. Once you add a second account, `auth status` switches to a per-account listing — see [`copillm auth`](../commands/auth/).

## 2. Launch an agent

The fastest path — copillm auto-starts the daemon and installs the agent on demand:

```bash
copillm claude     # launches Claude Code
copillm codex      # launches Codex CLI
copillm copilot    # launches GitHub Copilot CLI (reuses your stored token)
copillm pi         # launches the pi coding agent
```

Extra args are forwarded to the underlying agent:

```bash
copillm claude --model opus
copillm codex --help
```

That's it — you're talking to your Copilot seat through the agent of your choice.

## 3. (Optional) Run the daemon manually

If you'd rather manage the daemon yourself:

```bash
copillm start          # foreground
copillm start --detach # background
copillm status
copillm stop
```

Default bind is `http://127.0.0.1:4141`.

## Next steps

- See the [command reference](../commands/) for every command and flag
- Read the [Claude Code](../claude-code/) or [Codex](../codex/) guide for manual wiring and advanced tuning
- Check the [HTTP API reference](../http-api/) if you want to point your own scripts or third-party tools at copillm
