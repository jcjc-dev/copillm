---
title: Commands
layout: default
nav_order: 3
has_children: true
permalink: /commands/
---

# Commands

The `copillm` CLI groups commands by domain. Every command accepts `--json` for machine-readable output.

| Group | Description |
| --- | --- |
| [`auth`](auth/) | Sign in, sign out, and inspect credential state. |
| [`claude`](claude/) | Launch Claude Code, fully wired against the local daemon. |
| [`codex`](codex/) | Launch Codex CLI, fully wired against the local daemon. |
| [`daemon`](daemon/) | Start, stop, and inspect the background proxy daemon. |
| [`models`](models/) | List the upstream model catalogue and pin which models are advertised. |
| [`env`](env/) | Emit the environment block for manual agent wiring. |

See the [environment variables reference](environment/) for variables that affect every command.
