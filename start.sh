#!/usr/bin/env bash
# Dev wrapper around `copillm start` using the locally-built CLI.
#
# Runs in ISOLATED dev mode (`--dev`): the daemon uses a separate home
# (COPILLM_HOME=~/.copillm-dev) and a distinct default port (4142), so it can
# run side by side with a production copillm without ever touching its lock,
# config, model cache, or port. In particular, ./stop.sh can never kill the
# production daemon. The GitHub login is shared via the OS keychain, so no
# re-authentication is needed.
#
# Always rebuilds dist/ first (this is a dev-mode wrapper — pick up local
# source changes on every invocation), then launches the daemon in the
# foreground so the interactive login prompt is reachable. Pass --detach
# explicitly to run in the background (requires an existing credential).
#
# Examples:
#   ./start.sh                         # foreground dev daemon (isolated home)
#   ./start.sh --debug
#   ./start.sh --no-codex
#   ./start.sh --codex-model gpt-5.3-codex
#   ./start.sh --detach                # background; fails fast if not logged in
#   ./start.sh --json
#
# To target a custom dev home/port, export COPILLM_DEV_HOME / COPILLM_DEV_PORT.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building copillm..." >&2
npm run --silent build

exec node dist/cli.js --dev start "$@"
