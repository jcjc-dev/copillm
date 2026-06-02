---
title: copilot
layout: default
parent: Commands
nav_order: 6
---

# `copillm copilot`

Launch GitHub Copilot CLI using copillm's stored GitHub OAuth token, so you do not have to run a second device-flow login for `gh copilot`.

```bash
copillm copilot [args...]
```

Any arguments after `copilot` are forwarded verbatim to the underlying Copilot CLI:

```bash
copillm copilot --help
copillm copilot suggest -t shell "list large files"
```

## What it does

1. Reads the stored GitHub credential. If none is present, exits non-zero with `copillm: no stored GitHub credential — run `copillm auth login` first.`
2. Resolves the Copilot CLI binary in the same order as the other agent launchers — pinned `--copillm-use`/`COPILLM_COPILOT_VERSION`, then a system `copilot` on `PATH`, then a cached install at `~/.copillm/bin/copilot/<version>/`, then a fresh `npm install` of `@github/copilot`.
3. Spawns the Copilot CLI with `COPILOT_GITHUB_TOKEN` injected into the child environment only. Copilot CLI honours this variable ahead of its own stored credentials, which short-circuits its device-flow login.
4. Forwards stdin/stdout/stderr to the agent and exits with the agent's exit code.

> **Note:** Unlike `copillm claude` and `copillm codex`, this launcher does **not** start the local proxy daemon. copillm acts purely as a credential broker for Copilot CLI, so BYOK, model pinning, and HTTP-API-side translation do not apply to this command.

## Flags

Copillm reserves a small set of flags. Each has a long canonical form (`--copillm-*`) and a short alias. **Copillm consumes both forms before the agent sees them**, even if Copilot CLI would otherwise define the same short flag.

| Short | Long (canonical) | Description |
| --- | --- | --- |
| `--profile <name>` | `--copillm-profile <name>` | Override the active profile from `~/.copillm/agent.toml` for this launch. |
| `--use <spec>` | `--copillm-use <spec>` | Pin the Copilot CLI package version (e.g. `1.0.52` or `@github/copilot@1.0.52`). |
| `--no-config` | `--copillm-no-config` | Skip `agent.toml` fan-out for this launch. |
| `--yolo` | — | Allow all tools, paths, and URLs (injects `--allow-all`). Also reads `COPILLM_YOLO` — see [agent.toml docs](../../mcp/) for the tri-state precedence. |

Any other flags are forwarded to the Copilot CLI.

## Related environment variables

| Variable | Purpose |
| --- | --- |
| `COPILLM_COPILOT_VERSION` | Pin a specific Copilot CLI version. |
| `COPILLM_PROFILE` | Default profile selection used when `--copillm-profile` is not passed. |
| `COPILLM_YOLO` | Tri-state default for `--yolo` (`1`/`true`/`on` → enable; `0`/`false`/`off` → disable; unset → inherit `agent.toml`). |
