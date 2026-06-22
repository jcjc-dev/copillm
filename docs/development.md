---
title: Development & CI
layout: default
nav_order: 8
---

# Development & CI

## Contributing

Bug reports and pull requests are welcome. The development loop is:

1. **Build** — `npm install && npm run build` (see [Building from source](#building-from-source)).
2. **Develop against an isolated dev daemon**, never your everyday copillm. `npm run dev:start` runs your build on a separate home and port, so it can neither disturb nor be disturbed by a production daemon (see [Isolated dev mode](#isolated-dev-mode-run-dev--prod-side-by-side)).
3. **Validate before you push** — run the same checks CI enforces:

   ```bash
   npm run lint && npm test && npm run test:e2e:pr
   ```

   They are hermetic (a mock Copilot backend plus a throwaway config home), so they need no GitHub or Copilot credentials.
4. **Open a pull request** — `pr-gate` re-runs those checks on a 6-cell matrix (Linux / macOS / Windows × Node 20 / 22). Rebase on the latest `main` first; pull requests are squash-merged.

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

## Isolated dev mode (run dev + prod side by side)

Running a locally-built copillm against the default `~/.copillm` home and port
(4141) collides with a globally-installed production daemon: `stop` reads
`~/.copillm/copillm.pid` and would kill the production daemon, and `start` sees
the production lock and reports "already running" instead of launching your dev
build.

The global `--dev` flag (or `COPILLM_DEV=1`) redirects the runtime onto an
isolated home so a dev daemon and a production daemon can run **at the same
time** without ever touching each other's lock, config, model cache, or port:

```bash
node dist/cli.js --dev start --detach   # dev daemon: ~/.copillm-dev, port 4142
node dist/cli.js --dev status           # only ever reports the dev daemon
node dist/cli.js --dev stop             # only ever stops the dev daemon
```

Or use the npm scripts / wrapper shells. `dev:start` and `dev:stop` rebuild
`dist/` first and pass `--dev` for you (`dev:status` only reads the daemon's
lock, so it does not rebuild):

```bash
npm run dev:start        # foreground dev daemon (add -- --detach for background)
npm run dev:stop
npm run dev:status
./start.sh               # same as dev:start
./stop.sh                # same as dev:stop
```

To drive your build like a real CLI — including `copillm-dev claude` and the
other agent launchers — install a global `copillm-dev` command that runs this
checkout in `--dev` mode:

```bash
npm run build && npm run dev:link     # installs a global `copillm-dev` shim
copillm-dev start --detach
copillm-dev claude
npm run dev:unlink                    # remove it when you're done
```

`copillm-dev` is just a thin shim that execs this checkout's `dist/cli.js` with
`--dev`, so it shares the isolated home and port above and never collides with a
production `copillm`. Rebuild (`npm run build`) to pick up source changes.

What `--dev` changes:

- `COPILLM_HOME` → `~/.copillm-dev` (separate pid lock, `config.yaml`,
  `models.cache.json`, `debug.log`, and all generated agent config —
  Codex, Claude, pi, and Copilot).
- `COPILLM_PORT` → `4142` (still auto-increments if busy).
- Override the locations with `COPILLM_DEV_HOME` / `COPILLM_DEV_PORT`. An
  explicitly-set `COPILLM_HOME` / `COPILLM_PORT` always wins.

Because `stop` and `status` resolve the pid lock from `COPILLM_HOME`, a dev
`stop` **cannot** terminate a production daemon under `~/.copillm` — that's the
whole point. The GitHub login is shared via the OS keychain (a home-independent
`copillm` service entry), so the dev daemon reuses your production login with no
re-authentication.

> **Agent launches are isolated too.** copillm points every agent at a
> copillm-owned config home under `COPILLM_HOME` and never writes the agents'
> default paths: Codex via `CODEX_HOME`, Claude via `CLAUDE_CONFIG_DIR`, pi via
> `PI_CODING_AGENT_DIR`, and Copilot via `--additional-mcp-config`. So `--dev`
> isolates full agent launches as well — a dev `copillm claude`/`codex`/`pi`
> never touches your real `~/.claude` / `~/.codex` / `~/.pi`, and can run
> alongside a production-powered agent.

## Validating your changes

```bash
npm run lint
npm test                   # unit (vitest)
npm run test:e2e:pr        # synthetic Codex/Claude clients, no external installs
npm run test:e2e:release   # installs latest @openai/codex + @anthropic-ai/claude-code
```

The e2e runners are hermetic — they spin up a mock Copilot backend with a fictional model catalog, so they require no GitHub or Copilot credentials.

## CI: PR gate, upstream e2e, and the release pipeline

[![PR gate](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml/badge.svg?branch=main)](https://github.com/jcjc-dev/copillm/actions/workflows/pr-gate.yml)
[![Upstream e2e (nightly)](https://github.com/jcjc-dev/copillm/actions/workflows/upstream-e2e.yml/badge.svg?branch=main&event=schedule)](https://github.com/jcjc-dev/copillm/actions/workflows/upstream-e2e.yml)

Three workflows make up CI:

| Workflow | Triggers | What it runs |
|---|---|---|
| **PR gate** (`pr-gate.yml`) | every PR + push to `main` + manual | lint + build + unit tests (`vitest`) + E2E PR-gate runner (mock backend + synthetic Codex/Claude clients hitting copillm with the real wire format and SSE shapes). 6-cell matrix: `ubuntu-latest` × `macos-latest` × `windows-latest` on Node 20 and 22. |
| **Upstream e2e** (`upstream-e2e.yml`) | nightly cron at 09:00 UTC + manual + invoked by `release.yml` | build + unit tests (`vitest`) + E2E PR-gate runner + E2E upstream runner that installs the latest [`@openai/codex`](https://www.npmjs.com/package/@openai/codex) and [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) via `npx -y` and drives them through the mock-backed copillm stack. Same 6-cell matrix. (Lint runs in PR gate, not here.) |
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
