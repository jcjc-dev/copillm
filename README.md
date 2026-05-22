# copillm

[![PR gate](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml/badge.svg?branch=main)](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml)
[![Release gate](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml/badge.svg?branch=main&event=schedule)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml)
[![npm version](https://img.shields.io/npm/v/copillm.svg)](https://www.npmjs.com/package/copillm)
[![Node.js version](https://img.shields.io/node/v/copillm.svg)](https://www.npmjs.com/package/copillm)

A local proxy that exposes OpenAI- and Anthropic-compatible HTTP endpoints backed by a GitHub Copilot CLI subscription. A single login provides a unified gateway that Codex CLI, Claude Code, and other compatible tools can target directly.

## Requirements

- Node.js 20 or later
- An active GitHub Copilot subscription

## Installation

`copillm` is distributed on npm and can be invoked directly with `npx`. A global install is not required.

```bash
npx copillm --help
```

## Quick start

```bash
# Authenticate once via the GitHub device flow.
npx copillm login

# Launch an agent. copillm starts the local daemon, installs the agent if
# necessary, and configures the required environment variables.
npx copillm claude
npx copillm codex
```

Arguments after the agent name are forwarded to the underlying CLI:

```bash
copillm claude --model opus
copillm codex --help
```

## Documentation

Full documentation is published at **[jcjc-dev.github.io/copillm](https://jcjc-dev.github.io/copillm/)**.

| Topic | Description |
| --- | --- |
| [Getting started](https://jcjc-dev.github.io/copillm/getting-started/) | Installation, authentication, and first run |
| [CLI reference](https://jcjc-dev.github.io/copillm/cli-reference/) | Commands and flags |
| [Using with Claude Code](https://jcjc-dev.github.io/copillm/claude-code/) | Environment wiring, gateway discovery, the `[1m]` 1M-context alias |
| [Using with Codex CLI](https://jcjc-dev.github.io/copillm/codex/) | Environment wiring and `config.toml` generation |
| [HTTP API reference](https://jcjc-dev.github.io/copillm/http-api/) | Endpoints and translation behaviour |
| [Building from source](https://jcjc-dev.github.io/copillm/development/) | Contributor and CI guide |

## Contributing

Bug reports and pull requests are welcome. Please read the [development guide](https://jcjc-dev.github.io/copillm/development/) before opening a pull request.

## Disclaimer

`copillm` is an independent, unofficial client of GitHub Copilot's private API. It is not affiliated with, endorsed by, or supported by GitHub, Microsoft, OpenAI, or Anthropic. The upstream API may change at any time without notice. Use this project at your own risk.

## License

Released under the [MIT License](LICENSE).
