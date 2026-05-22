---
title: models
layout: default
parent: Commands
nav_order: 5
---

# Model commands

The daemon advertises the upstream Copilot model catalogue to downstream agents. The commands below inspect that catalogue and let you pin a subset.

## `copillm models list`

Fetch the live model catalogue from Copilot's `/models` endpoint for the configured account type and snapshot the result to `~/.copillm/models.cache.json`. If upstream discovery is unreachable, the command falls back to the snapshot and prints a stale-cache warning.

```bash
copillm models list [--json]
```

## `copillm models select`

Pin which models the daemon advertises downstream. Useful when an agent's model picker should only see a curated subset.

```bash
copillm models select --models modelA,modelB [--json]
```

| Flag | Description |
| --- | --- |
| `--models` | Comma-separated list of model identifiers to advertise. |
| `--json` | Emit a JSON result instead of human output. |
