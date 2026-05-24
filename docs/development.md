---
title: Development & CI
layout: default
nav_order: 8
---

# Development & CI

## Building from source

```bash
git clone https://github.com/jcjc-dev/copillm.git
cd copillm
npm install
npm run build
```

`prepack` runs `npm run build`, so published npm tarballs include `dist/cli.js` for `npx`.

## Running locally

```bash
node dist/cli.js login
node dist/cli.js start
```

Or link globally for development:

```bash
npm link
copillm status
```

## Tests

```bash
npm run lint
npm test                   # unit (vitest)
npm run test:e2e:pr        # synthetic Codex/Claude clients, no external installs
npm run test:e2e:release   # installs latest @openai/codex + @anthropic-ai/claude-code
```

The mock backend (`tests/mock-backend/`) serves a fictional model catalog (`claude-test-opus`, `claude-test-sonnet`, `claude-test-haiku`, `gpt-test`, `gpt-test-codex`) so tests are hermetic and require no GitHub or Copilot credentials.

## CI: PR gate, upstream e2e, and the release pipeline

[![PR gate](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml/badge.svg?branch=main)](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml)
[![Upstream e2e (nightly)](https://github.com/jcjc-dev/copillm/actions/workflows/upstream-e2e.yml/badge.svg?branch=main&event=schedule)](https://github.com/jcjc-dev/copillm/actions/workflows/upstream-e2e.yml)

Three workflows make up CI:

| Workflow | Triggers | What it runs |
|---|---|---|
| **PR gate** (`pr-gate.yml`) | every PR + push to `main` + manual | lint + build + unit tests (`vitest`) + E2E PR-gate runner (mock backend + synthetic Codex/Claude clients hitting copillm with the real wire format and SSE shapes). 6-cell matrix: `ubuntu-latest` × `macos-latest` × `windows-latest` on Node 20 and 22. |
| **Upstream e2e** (`upstream-e2e.yml`) | nightly cron at 09:00 UTC + manual + invoked by `release.yml` | everything in PR gate + E2E upstream runner that installs the latest [`@openai/codex`](https://www.npmjs.com/package/@openai/codex) and [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) via `npx -y` and drives them through the mock-backed copillm stack. Same 6-cell matrix. |
| **Release** (`release.yml`) | push to `main` that touches `package.json` + manual | detects a version bump, tags `v<version>`, invokes `upstream-e2e` as a gate, publishes to npm with provenance, then creates a GitHub Release with auto-generated notes. |

The nightly `upstream-e2e` run is the canary: it catches `@openai/codex` / `@anthropic-ai/claude-code` shipping breaking changes against copillm without waiting for someone to cut a release. The same workflow doubles as the pre-publish gate inside `release.yml` (via `workflow_call`), so `npm publish` only runs after the full matrix passes.

The `upstream-e2e` workflow accepts `workflow_dispatch` inputs to pin specific package versions:

- `codex_package` (default `@openai/codex@latest`)
- `claude_package` (default `@anthropic-ai/claude-code@latest`)

## Releasing

Releases are fully automated from `package.json`:

1. Open a PR that bumps `version` in `package.json` (and `package-lock.json`).
2. Once `pr-gate` is green, merge it to `main`.
3. `release.yml` notices the version field changed and runs the linear pipeline: **detect → tag → upstream-e2e gate → npm publish → GitHub Release**.

No local `git tag` / `npm version` / `gh release create` / `gh workflow run` steps required. The detect job is idempotent — re-runs (or pushes that don't actually change the version) skip downstream jobs. To retry a failed publish for the current `package.json` version, dispatch `release.yml` manually.
