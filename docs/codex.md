---
title: Using with Codex CLI
layout: default
nav_order: 5
---

# Using with Codex CLI

## The easy way

```bash
copillm codex
```

That handles login check, daemon start, agent install/resolve, and env wiring.

## Manual wiring

If you'd rather wire it up yourself, `copillm env codex` prints the env block:

```bash
$ copillm env codex
# Codex CLI → copillm
export CODEX_HOME="/Users/you/.copillm/codex"
```

`copillm start` already generates `~/.copillm/codex/config.toml` with the right `[model_providers]` block for live discovery against the local proxy.

`--shell fish` and `--shell powershell` are also supported, and `--json` returns a machine-readable payload.

## Generated `config.toml`

The auto-generated `~/.copillm/codex/config.toml` points Codex's model provider at `http://127.0.0.1:4141/codex` and enables live model discovery via the `/codex/v1/models` endpoint. You can override `CODEX_HOME` to point Codex at a different config location if you want to manage it yourself.

To make the default Codex install use copillm without launching through `copillm codex`, run:

```bash
copillm config sync --agent codex
```

That merges the generated copillm provider block into `~/.codex/config.toml` and applies the active profile's MCP servers there.

## Pass-through args

```bash
copillm codex --model gpt-5
copillm codex --help
```

Any extra flags or positional args are forwarded verbatim to the `codex` binary.
