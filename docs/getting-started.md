---
title: Getting started
nav_order: 2
---

# Getting started

## Requirements

- Node.js ≥ 20
- A GitHub account with an active **Copilot subscription** (Individual, Business, or Enterprise — Pro+ tier required for Claude/GPT model access)

No global install needed; everything runs through `npx`. For repeatable automation, pin a version (e.g. `npx copillm@0.1.0 ...`).

## 1. Log in

```bash
npx copillm login
```

This kicks off GitHub's device-flow OAuth — you'll see a code to paste into `github.com/login/device`. The resulting token is stored in your OS keychain (via [`keytar`](https://github.com/atom/node-keytar)) when available, otherwise in `~/.copillm/credentials.json` with 0600 perms.

Verify with:

```bash
npx copillm auth status
# stored: true
# backend: keytar
# user: { login: "your-handle", name: "Your Name" }
```

The token is **never** printed.

## 2. Launch an agent

The fastest path — copillm auto-starts the daemon and installs the agent on demand:

```bash
copillm claude     # launches Claude Code
copillm codex      # launches Codex CLI
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

- See the [CLI reference](../cli-reference/) for every command and flag
- Read the [Claude Code](../claude-code/) or [Codex](../codex/) guide for manual wiring and advanced tuning
- Check the [HTTP API reference](../http-api/) if you want to point your own scripts or third-party tools at copillm
