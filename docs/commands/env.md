---
title: env
layout: default
parent: Commands
nav_order: 6
---

# `copillm env`

Print the environment block required to wire an agent against copillm manually. Useful when integrating copillm into your own shell profile or process supervisor instead of using the `copillm claude` / `copillm codex` launchers.

```bash
copillm env <codex|claude> [--shell sh|fish|powershell] [--json] [--inline]
```

| Flag | Description |
| --- | --- |
| `--shell` | Format the output for the given shell. Defaults to a POSIX `sh`-compatible block. |
| `--json` | Emit `{ var: value }` pairs as JSON. |
| `--inline` | Emit a single-line `KEY=VAL KEY=VAL` form suitable for prefixing a command. |

See the [Using with Claude Code](../../claude-code/) and [Using with Codex CLI](../../codex/) guides for end-to-end wiring examples.
