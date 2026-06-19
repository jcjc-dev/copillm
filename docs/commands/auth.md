---
title: auth
layout: default
parent: Commands
nav_order: 1
---

# `copillm auth`

Authentication against GitHub Copilot uses the GitHub device flow. Credentials are stored in your OS keychain (Keychain on macOS, Credential Manager on Windows, libsecret on Linux); the token is never written to disk in plaintext and never printed to stdout or logs.

copillm can hold **more than one GitHub account** at once and serve them all from the same daemon. If you only ever use one account, nothing below changes — you never name an account, no accounts index is created, and `auth login` / `logout` / `status` behave exactly as they always have. The multi-account surface only appears once you add a second account.

> **Upgrading from copillm ≤ 0.2.1:** the credential storage backend changed. On macOS you may see a one-time "copillm wants to access your keychain" prompt the first time the new version reads your existing credential. On Linux, run `copillm auth login` once to re-store the token under the new backend.

## `copillm auth login`

Begin the GitHub device flow. The CLI prints a verification URL and a one-time code; complete the flow in your browser to finish signing in.

```bash
copillm auth login [--json] [--as <account>] [--account-type <type>]
```

| Flag | Description |
| --- | --- |
| `--as <account>` | Name this account, enabling multiple accounts. The name must start with a letter or digit and may then contain letters, digits, `.`, `_`, and `-` (so a GitHub login always qualifies), up to 64 characters — it matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`. |
| `--account-type <type>` | Record the account's Copilot plan: `individual`, `business`, or `enterprise`. |
| `--json` | Emit a JSON result instead of human output. |

**Your first login is the default account** — no name needed. The account you log into most recently becomes the default (logging in is how you say "I want to use this account").

How a plain `copillm auth login` (no `--as`) behaves depends on the GitHub identity behind the new token:

- **Same login as an existing account** → that account's credential is refreshed in place. No second account is created.
- **A different login** → copillm transitions to multi-account: your previous account is preserved alongside the new one, and the **just-signed-in account becomes the default** (it's the one you clearly intend to use right now). Use [`copillm auth switch`](#copillm-auth-switch) later if you want a different default.
- **Identity can't be confirmed** (e.g. GitHub's `/user` lookup is briefly throttled right after the device-flow exchange) → copillm refuses rather than risk overwriting the wrong account's credential, and leaves everything untouched. Re-run the login once GitHub is reachable.

Use `--as <account>` to skip the guesswork and add or refresh a specifically named account:

```bash
copillm auth login --as work
copillm auth login --as work --account-type business   # also record its plan type
```

Exit codes: `0` on success, `1` on error.

## `copillm auth status`

Report credential state. The token itself is **never** included in any output.

```bash
copillm auth status [--json] [--no-user]
```

| Flag | Description |
| --- | --- |
| `--json` | Emit a JSON result. The shape depends on whether you have multiple accounts (see below). |
| `--no-user` | Skip the `GET https://api.github.com/user` lookup. The status falls back to this behaviour automatically when the GitHub API is unreachable. |

**Single account** (no accounts index): the original one-line output. The `(Your Name)` portion appears only when your GitHub display name differs from your login.

```text
logged in as @your-handle (Your Name) (OS keychain)
```

```jsonc
// --json
{ "status": "logged_in", "stored": true, "backend": "keyring", "user": { "login": "your-handle", "name": "Your Name" } }
```

**Multiple accounts:** a compact listing led by the default account, which is marked with `*`. The GitHub login is shown only when it differs from the account id, and an account with no stored credential is flagged.

```text
copillm — 2 accounts · default: personal

  * personal  (default)
    work      (@work-handle)

Switch default: copillm auth switch <account>   ·   per launch: --account <account>
```

```jsonc
// --json — one entry per account, plus which one is the default
{
  "status": "logged_in",
  "default": "personal",
  "accounts": [
    { "id": "personal", "account_type": "individual", "storage": "legacy",     "default": true,  "stored": true, "backend": "keyring", "user": { "login": "personal", "name": "..." } },
    { "id": "work",     "account_type": "business",    "storage": "namespaced", "default": false, "stored": true, "backend": "keyring", "user": { "login": "work-handle", "name": "..." } }
  ]
}
```

Exit codes: `0` when at least one credential is stored, `2` when none is, `1` on error.

## `copillm auth switch`

Set which account is the **default** — the one every agent launch and the model endpoints use unless told otherwise.

```bash
copillm auth switch <account> [--json]
```

```text
$ copillm auth switch work
Default account is now "work". Restart the daemon for this to take effect: copillm restart.
```

A running daemon snapshots the default account at startup, so a switch only affects **new** agent launches after the daemon is restarted. When a daemon is running, `auth switch` tells you so and sets `"restart_required": true` in its `--json` payload; restart with [`copillm restart`](../daemon/#copillm-restart). (`auth logout` stops the daemon for you, so it never needs this.)

Exit codes: `0` on success, `1` on error (e.g. an unknown account name).

## `copillm auth logout`

Clear stored credentials and stop the daemon if it is running.

```bash
copillm auth logout [--json] [--account <account> | --all]
```

| Flag | Description |
| --- | --- |
| `--account <account>` | Log out a single named account. Defaults to the current default account. |
| `--all` | Log out of every account and remove the accounts index. |
| `--json` | Emit a JSON result instead of human output. |

With no flags on a single-account install, this clears the one stored credential as before. On a multi-account install, logging out of the **default** account automatically reassigns the default to a remaining account (`Default is now "..."`); logging out of the last one removes the accounts index entirely.

Exit codes: `0` on success, `1` on error.

## The accounts index

The moment you have more than one account, copillm records which accounts exist and which is the default in `~/.copillm/accounts.json`. This file holds **metadata only** — it never contains a token. Single-account installs have no index at all, and deleting it (or logging out of all but one account) returns you to the single-account behaviour.

## Deprecated aliases

| Command | Replacement |
| --- | --- |
| `copillm login` | `copillm auth login` |
| `copillm logout` | `copillm auth logout` |

These remain available for backwards compatibility but emit a deprecation notice.
