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

## CI: PR gate, release gate, and nightly schedule

[![PR gate](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml/badge.svg?branch=main)](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml)
[![Release gate (nightly + on release)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml/badge.svg?branch=main&event=schedule)](https://github.com/jcjc-dev/copillm/actions/workflows/release-gate.yml)

Two workflows, both running a `ubuntu-latest` × `macos-latest` × `windows-latest` matrix on Node 20 and 22:

| Workflow | Triggers | What it runs |
|---|---|---|
| **PR gate** (`pr-gate.yml`) | every PR + push to `main` + manual | lint + build + unit tests (`vitest`) + E2E PR-gate runner (mock backend + synthetic Codex/Claude clients hitting copillm with the real wire format and SSE shapes) |
| **Release gate** (`release-gate.yml`) | nightly cron at 09:00 UTC + manual + invoked by `publish.yml` on release | everything in PR gate + E2E release runner that installs the latest [`@openai/codex`](https://www.npmjs.com/package/@openai/codex) and [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) via `npx -y` and drives them through the mock-backed copillm stack |

The nightly schedule on the release gate gives daily signal on whether copillm still works against the latest published Codex/Claude Code releases — useful for catching upstream wire-format regressions without waiting for someone to cut a copillm release. On release, the gate runs as a prerequisite job inside `publish.yml` (via `workflow_call`), so `npm publish` only fires after the full matrix passes.

The release-gate workflow accepts `workflow_dispatch` inputs to pin specific package versions:

- `codex_package` (default `@openai/codex@latest`)
- `claude_package` (default `@anthropic-ai/claude-code@latest`)

## Releasing

Tag and push:

```bash
git tag v0.x.y
git push --tags
```

Then publish to npm — `prepack` rebuilds, so `dist/cli.js` is always fresh.
