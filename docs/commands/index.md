---
title: Commands
layout: default
nav_order: 3
has_children: true
permalink: /commands/
---

# Commands

The `copillm` CLI groups commands by domain. Most management commands accept `--json` for machine-readable output. (Agent launchers forward all non-copillm flags straight to the underlying agent.)

## Global flags

| Flag | Description |
| --- | --- |
| `--debug` | Enable copillm debug mode for the command. For daemon starts this enables `/_debug`, sets daemon logging to debug, and writes detached daemon logs to `~/.copillm/debug.log`. Put this before the subcommand, e.g. `copillm --debug claude`. |
| `--no-update-notifier` | Skip the npm registry update check for this run. (Also controllable via `COPILLM_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` — see [environment variables](environment/).) |

Agent arguments still belong after the agent command. For example, `copillm --debug claude -- --debug` enables copillm debug mode and forwards `--debug` to Claude Code.

| Group | Description |
| --- | --- |
| [`auth`](auth/) | Sign in, sign out, and inspect credential state. |
| [`claude`](claude/) | Launch Claude Code, fully wired against the local daemon. |
| [`codex`](codex/) | Launch Codex CLI, fully wired against the local daemon. |
| [`copilot`](copilot/) | Launch GitHub Copilot CLI with the stored GitHub token injected (no second device-flow login). |
| [`pi`](pi/) | Launch the pi coding agent, fully wired against the local daemon. |
| [`daemon`](daemon/) | Start, stop, and inspect the background proxy daemon. |
| [`env`](env/) | Emit the environment block for manual agent wiring. |
| [`models`](models/) | List the upstream model catalogue and pin which models are advertised. |
| [`config`](../mcp/) | Manage `~/.copillm/agent.toml` — profiles, MCP servers, instructions, and yolo defaults. |

See the [environment variables reference](environment/) for variables that affect every command.
