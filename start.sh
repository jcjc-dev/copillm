#!/usr/bin/env bash
# Dev wrapper around `copillm start` using the locally-built CLI.
#
# Always rebuilds dist/ first (this is a dev-mode wrapper — pick up local
# source changes on every invocation), then launches the daemon in the
# foreground so the interactive login prompt is reachable. Pass --detach
# explicitly to run in the background (requires an existing credential).
#
# Examples:
#   ./start.sh                         # foreground, prompts to log in if needed
#   ./start.sh --debug
#   ./start.sh --no-codex
#   ./start.sh --codex-model gpt-5.3-codex
#   ./start.sh --detach                # background; fails fast if not logged in
#   ./start.sh --json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building copillm..." >&2
npm run --silent build

exec node dist/cli.js start "$@"
