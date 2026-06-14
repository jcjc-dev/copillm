# copillm

[![PR gate](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml/badge.svg?branch=main)](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml)
[![Upstream e2e (nightly)](https://github.com/jcjc-dev/copillm/actions/workflows/upstream-e2e.yml/badge.svg?branch=main&event=schedule)](https://github.com/jcjc-dev/copillm/actions/workflows/upstream-e2e.yml)
[![npm version](https://img.shields.io/npm/v/copillm.svg)](https://www.npmjs.com/package/copillm)
[![Node.js version](https://img.shields.io/node/v/copillm.svg)](https://www.npmjs.com/package/copillm)

One Copilot subscription. Every coding agent. A unified gateway for Claude Code, Codex CLI, and any OpenAI- or Anthropic-compatible tool, with authentication, MCPs, and environment configs handled automatically.

## Requirements

- Node.js 20 or later
- An active GitHub Copilot subscription

## Installation

`copillm` is distributed on [npm](https://www.npmjs.com/package/copillm). Install it globally for the most convenient usage:

```bash
npm install -g copillm

copillm --help
```

Alternatively, you can invoke it directly with `npx` without a global install:

```bash
npx copillm --help
```

### Preview (beta) releases

Experimental builds are published to the `beta` channel ahead of a stable
release. They let you try in-progress features early; expect rough edges. Stable
installs are never affected unless you explicitly opt in:

```bash
npm install -g copillm@beta
```

To return to the stable channel, reinstall without the tag: `npm install -g copillm@latest`.

## Quick start

```bash
# Authenticate once via the GitHub device flow.
copillm login

# Launch an agent. copillm starts the local daemon, installs the agent if
# necessary, and configures the required environment variables.
copillm claude
copillm codex
copillm copilot   # GitHub Copilot CLI, signed in with copillm's token
```

Arguments after the agent name are forwarded to the underlying CLI:

```bash
copillm claude --model opus
copillm codex --help
```

## Multiple accounts

copillm can hold more than one GitHub account at once and serve them from the
same daemon. If you only ever use one account, nothing changes — you never see
any of this.

```bash
# Your first login is the default account (no naming needed).
copillm auth login

# Add another account under a name of your choice.
copillm auth login --as work
copillm auth login --as work --account-type business   # set its plan type

# See every account; the default is marked with *.
copillm auth status

# Change which account is the default.
copillm auth switch work

# Log out of one account, or all of them.
copillm auth logout --account work
copillm auth logout --all
```

The **default account** is what every agent and the model endpoints use unless
told otherwise. `copillm auth status` lists each account with its plan type and
whether a credential is stored; tokens are never printed.

If the daemon is already running when you `auth switch`, copillm reminds you to
run `copillm restart` so the new default takes effect for the next agent launch.
(`auth logout` stops the daemon for you, so it needs no restart.)

Different accounts can be entitled to different models, so each account keeps
its own model list.

### Launching an agent against a specific account

Point any agent at a non-default account for a single launch with `--account`,
or set `COPILLM_ACCOUNT` in the environment:

```bash
copillm codex --account work
COPILLM_ACCOUNT=work copillm claude
```

To make it automatic, pin an account to a profile in `~/.copillm/agent.toml`
(or a project's `.copillm/agent.toml`):

```toml
[profiles.work]
account = "work"
```

Then `copillm codex --profile work` always uses the `work` account. Precedence
is `--account` > `COPILLM_ACCOUNT` > the profile's pinned account > the default
account. copillm prints a short notice such as `using account "work" (from
profile)` so you always know which account a launch is using, and refuses to
launch with a clear error if the account isn't one you've logged into.

## Documentation

Full documentation is published at **[jcjc-dev.github.io/copillm](https://jcjc-dev.github.io/copillm/)**.

| Topic | Description |
| --- | --- |
| [Getting started](https://jcjc-dev.github.io/copillm/getting-started/) | Installation, authentication, and first run |
| [CLI reference](https://jcjc-dev.github.io/copillm/commands/) | Commands and flags |
| [Using with Claude Code](https://jcjc-dev.github.io/copillm/claude-code/) | Environment wiring, gateway discovery, the `[1m]` 1M-context alias |
| [Using with Codex CLI](https://jcjc-dev.github.io/copillm/codex/) | Environment wiring and `config.toml` generation |
| [HTTP API reference](https://jcjc-dev.github.io/copillm/http-api/) | Endpoints and translation behaviour |
| [Building from source](https://jcjc-dev.github.io/copillm/development/) | Contributor and CI guide |

## Contributing

Bug reports and pull requests are welcome. Develop against an isolated dev daemon (`npm run dev:start`) so you don't disturb a running copillm, and run `npm run lint && npm test && npm run test:e2e:pr` before opening a pull request. See the [development guide](https://jcjc-dev.github.io/copillm/development/) for the full workflow.

## Disclaimer

`copillm` is an independent, unofficial client of GitHub Copilot's private API. It is not affiliated with, endorsed by, or supported by GitHub, Microsoft, OpenAI, or Anthropic. The upstream API may change at any time without notice. Use this project at your own risk.

## License

Released under the [MIT License](LICENSE).
