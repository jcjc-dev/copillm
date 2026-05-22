---
title: auth
layout: default
parent: Commands
nav_order: 1
---

# `copillm auth`

Authentication against GitHub Copilot uses the GitHub device flow. Credentials are stored in the OS keychain via `keytar`; the token is never written to disk in plaintext and never printed to stdout or logs.

## `copillm auth login`

Begin the GitHub device flow. The CLI prints a verification URL and a one-time code; complete the flow in your browser to finish signing in.

```bash
copillm auth login [--json]
```

| Flag | Description |
| --- | --- |
| `--json` | Emit a JSON result instead of human output. |

Exit codes: `0` on success, `1` on error.

## `copillm auth logout`

Clear the stored credential and stop the daemon if it is running.

```bash
copillm auth logout [--json]
```

| Flag | Description |
| --- | --- |
| `--json` | Emit a JSON result instead of human output. |

Exit codes: `0` on success, `1` on error.

## `copillm auth status`

Report the current credential state and, when authenticated, the GitHub login associated with the token. The token itself is never included in any output.

```bash
copillm auth status [--json] [--no-user]
```

| Flag | Description |
| --- | --- |
| `--json` | Emit `{ stored, backend, user }` as JSON. |
| `--no-user` | Skip the `GET https://api.github.com/user` lookup. The status falls back to this behaviour automatically when the GitHub API is unreachable. |

Exit codes: `0` when authenticated, `2` when not, `1` on error.

## Deprecated aliases

| Command | Replacement |
| --- | --- |
| `copillm login` | `copillm auth login` |
| `copillm logout` | `copillm auth logout` |

These remain available for backwards compatibility but emit a deprecation notice.
