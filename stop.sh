#!/usr/bin/env bash
# Dev wrapper around `copillm stop` using the locally-built CLI.
#
# Runs in ISOLATED dev mode (`--dev`): it stops ONLY the dev daemon
# (COPILLM_HOME=~/.copillm-dev). It reads the dev home's pid file, so it can
# never stop a production copillm daemon running under ~/.copillm.
#
# Always rebuilds dist/ first (this is a dev-mode wrapper — pick up local
# source changes on every invocation), then stops the detached dev daemon. The
# CLI also clears the Claude Code gateway cache as part of stop.
#
# Extra arguments are forwarded, e.g.:
#   ./stop.sh --json
#
# To target a custom dev home, export COPILLM_DEV_HOME.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building copillm..." >&2
npm run --silent build

exec node dist/cli.js --dev stop "$@"
