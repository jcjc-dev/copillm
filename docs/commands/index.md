---
title: Commands
layout: default
nav_order: 3
has_children: true
permalink: /commands/
---

# Commands

The `copillm` CLI groups commands by domain. Every command accepts `--json` for machine-readable output.

## Global flags

| Flag | Description |
| --- | --- |
| `--debug` | Enable copillm debug mode for the command. For daemon starts this enables `/_debug`, sets daemon logging to debug, and writes detached daemon logs to `~/.copillm/debug.log`. Put this before the subcommand, e.g. `copillm --debug claude`. |

Agent arguments still belong after the agent command. For example, `copillm --debug claude -- --debug` enables copillm debug mode and forwards `--debug` to Claude Code.

| Group | Description |
| --- | --- |
| [`auth`](auth/) | Sign in, sign out, and inspect credential state. |
| [`claude`](claude/) | Launch Claude Code, fully wired against the local daemon. |
| [`codex`](codex/) | Launch Codex CLI, fully wired against the local daemon. |
| [`copilot`](copilot/) | Launch GitHub Copilot CLI with the stored GitHub token injected (no second device-flow login). |
| [`daemon`](daemon/) | Start, stop, and inspect the background proxy daemon. |
| [`models`](models/) | List the upstream model catalogue and pin which models are advertised. |
| [`env`](env/) | Emit the environment block for manual agent wiring. |

See the [environment variables reference](environment/) for variables that affect every command.
