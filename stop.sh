#!/usr/bin/env bash
# Dev wrapper around `copillm stop` using the locally-built CLI.
#
# Always rebuilds dist/ first (this is a dev-mode wrapper — pick up local
# source changes on every invocation), then stops the detached daemon. The
# CLI also clears the Claude Code gateway cache as part of stop.
#
# Extra arguments are forwarded, e.g.:
#   ./stop.sh --json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building copillm..." >&2
npm run --silent build

exec node dist/cli.js stop "$@"
