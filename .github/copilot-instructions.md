# Copilot instructions for `copillm`

> Repo-wide guidance for GitHub Copilot. Keep this file terse — it is prepended to every Copilot interaction in the repo.

## What this repo is

**copillm** is a TypeScript CLI that runs a local proxy daemon exposing OpenAI-compatible (`/v1/chat/completions`, `/responses`) and Anthropic-compatible (`/anthropic/v1/messages`) endpoints backed by GitHub Copilot's private API. It also serves runtime model-discovery endpoints that Codex CLI and Claude Code consume.

This is an **independent, unofficial client** of GitHub Copilot — not affiliated with GitHub, Microsoft, OpenAI, or Anthropic. The README's experimental disclaimer applies.

## Tech stack

- Node.js **≥ 20**, ESM-only (`"type": "module"` in `package.json` — every relative import must end in `.js` even in TypeScript files)
- TypeScript with `"strict": true`
- HTTP: use the standard library — Node ships `fetch`/`Response`/`Headers` as globals; no third-party HTTP client is needed.
- Validation: `zod`
- Config format: YAML (`yaml` package) for `~/.copillm/config.yaml`, TOML for the generated Codex config
- Tests: `vitest` (unit), custom Node runners for E2E (`tests/e2e/`)
- Logger: `pino` with structured JSON

## Commands you should use

```bash
npm run build              # tsc -p tsconfig.json
npm run lint               # tsc --noEmit on src/ AND tests/
npm test                   # vitest run (unit tests)
npm run test:e2e:pr        # mock backend + synthetic clients (fast)
npm run test:e2e:release   # mock backend + real Codex + real Claude Code (installs via npx)
node dist/cli.js start --detach    # run the daemon
node dist/cli.js stop              # stop daemon (clears Claude gateway cache too)
node dist/cli.js status            # check daemon + bearer health
```

When you run something on this repo, **prefer the npm scripts above over inferring fresh tooling commands**. The lint script type-checks `tests/` too via `tsconfig.tests.json`.

## Repo layout

```
src/
  cli.ts                       # commander entry point (login/logout/start/stop/status/health/models)
  auth/                        # GitHub device flow, credential storage, Copilot token manager
  config/
    upstream.ts                # ALL upstream URLs go through here (see "Conventions" below)
    home.ts, config.ts, fsSecurity.ts
  models/
    discovery.ts               # /models fetch + cache
    anthropicDefaults.ts       # auto-pick latest plain Claude variant per family
  server/
    proxy.ts                   # the HTTP daemon
    codexSchema.ts             # buildCodexCatalog() filter for /codex/v1/models
    anthropicModelsResponse.ts # Anthropic-spec /v1/models shape for gateway discovery
  translation/
    openaiAnthropic.ts                  # request body + non-streaming response translation
    streamingOpenAIToAnthropic.ts       # SSE translator (canonical Anthropic event sequence)
  codex/init.ts                # generates ~/.copillm/codex/config.toml
  claude/cache.ts              # clears ~/.claude/cache/gateway-models.json on stop
tests/
  *.test.ts                    # unit tests (vitest)
  mock-backend/                # standalone HTTP server that mimics Copilot upstream
  e2e/
    pr-gate-runner.ts          # synthetic clients
    release-runner.ts          # real Codex + Claude Code via npx
    clients/                   # codexLikeClient.ts, claudeLikeClient.ts
.github/
  workflows/pr-gate.yml        # matrix: ubuntu/macos/windows × Node 20/22
  workflows/release-gate.yml   # release publish + nightly cron + dispatch
  rulesets/main.json           # blocks direct push to main + force-push + branch deletion
```

## Conventions (enforce these)

- **All upstream URLs flow through `src/config/upstream.ts`.** Never hardcode `api.githubcopilot.com`, `api.github.com`, or any host. Production defaults live in `upstream.ts`; tests override via `COPILLM_UPSTREAM_BASE_URL`, `COPILLM_TOKEN_EXCHANGE_URL`, `COPILLM_GITHUB_USER_URL` env vars.
- **Streaming SSE translation must preserve the canonical Anthropic event sequence**: `message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop`. Tool-use blocks emit `input_json_delta` deltas. Don't reorder.
- **Codex consumes `/codex/v1/models`** (Codex-shape catalog with `slug`, `display_name`, `supported_reasoning_levels`, etc.). Filter via `isCodexEligible` in `src/server/codexSchema.ts`: `model_picker_enabled === true` AND `policy.state === "enabled"` (or absent) AND `supported_endpoints` includes `/responses`.
- **Claude Code consumes `/anthropic/v1/models`** (Anthropic spec shape: `{ data: [{ type: "model", id, display_name, created_at }], has_more, first_id, last_id }`). Filtered to `claude*` / `anthropic*` IDs.
- **Codex uses live discovery for its model catalog.** The generated `~/.copillm/codex/config.toml` carries only the provider routing block and the default `model` slug. Don't add a separate catalog file or any `model_catalog_json` setting — Codex fetches `<base_url>/models?client_version=…` at startup.
- **The Codex CLI's `model_provider.base_url` is `http://127.0.0.1:<port>/codex/v1`**. Codex appends `/models` and `/responses` itself.
- **`copillm stop` always clears `~/.claude/cache/gateway-models.json`.** This is intentional — Claude Code persists the gateway model picker across restarts otherwise. Don't add an opt-out flag.
- **Loopback-only enforcement**: the proxy rejects non-`127.0.0.1` / `::1` requests with 403. Don't bind to `0.0.0.0`.
- **Bearer tokens are memory-only**, never persisted to disk. The GitHub OAuth token persists (OS keychain, `~/.copillm/credentials.json` fallback, or in-memory `"session"` backend). Don't write bearers anywhere.
- **Credential file fallback** is gated by `COPILLM_ALLOW_PLAINTEXT_CREDENTIALS=1` in non-TTY contexts. Don't relax this gate.
- **`auth status` and the `status.auth` block never print the token.** They use `inspectStoredCredential()` (which reports presence + backend only), not `loadStoredCredential()` (which returns the token). `tests/authStatusCli.test.ts` enforces this with a substring-leak guard. Don't wire status surfaces through `loadStoredCredential`.

## Test fixtures and naming

- All fictional models in `tests/mock-backend/fixtures.ts` use deliberately generic names: `claude-test-opus`, `claude-test-sonnet`, `claude-test-haiku`, `gpt-test`, `gpt-test-codex`. **Do not introduce real product names or version numbers in test fixtures.**
- Test runs are hermetic: spawn the mock backend, seed a tmpdir-backed `COPILLM_HOME` with a fake GitHub token, point copillm at the mock via env-var overrides. Never make a test require real Copilot credentials.
- `COPILLM_FORCE_SESSION_BACKEND=1` is a test-only seam that short-circuits the keychain detection in `src/auth/credentials.ts` and disables the plaintext-fallback gate, forcing the `auth login` flow to land on the in-memory `"session"` backend. Useful for exercising the session path deterministically on machines with a working keychain. Also exposed as a hidden `--force-session` flag on `auth login`. Not documented in the user-facing README.

## PR / commit workflow

- **Always raise a PR; never push or merge directly to `main`.** A ruleset config sits at `.github/rulesets/main.json` to formalize this, but it is not actively enforced on this private repo, so discipline is on us. Branch off `main`, push your feature branch, and open a PR — every time, including for trivial changes.
- **Always rebase your feature branch onto latest `origin/main` before opening a PR.** Conflicts in this repo are usually trivial (different subtrees) but check anyway.
- **Run the full local pipeline before pushing**: `npm run lint && npm test && npm run test:e2e:pr`. The PR-gate workflow runs the same on every push to a 6-cell matrix.
- **After pushing, watch CI in the background — don't block on it.** Spawn `gh pr checks <number> --watch` as an asynchronous/detached task using whatever background-execution primitive your environment provides (agent background-task tools, scheduled re-prompts, `setsid` / `nohup … &`, a detached shell session, etc.) so it can notify you when the matrix resolves rather than holding the session open. Fall back to a foreground `gh pr checks <number> --watch` only when no async mechanism is available. Either way, the work isn't finished until every matrix cell is green — if any cell fails, surface the failure to the user and fix it before handing off. Don't declare the task done while runs are queued or in-progress unless a background watcher is in place that will report the outcome back to the user when it resolves.
- **Commit messages**: imperative subject ≤ 72 chars, blank line, then a body explaining the *why*. End with the project's `Co-authored-by: Copilot <...>` trailer when AI-assisted (handled by tooling, do not strip).
- **PR titles** match commit subjects when there's one logical change. Use prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.
- **Squash-merge** is the default. Branches auto-delete after merge.

## Things to avoid

- Adding a third-party HTTP client — use Node's built-in `fetch`.
- Hardcoding URLs — go through `src/config/upstream.ts`.
- Touching `~/.claude/settings.json` or `~/.codex/config.toml` from copillm code. We document env-var workflows; we don't write into other tools' config.
- Adding a `model_catalog.json` file or `model_catalog_json` TOML key for Codex — discovery is live.
- Adding `--keep-claude-cache` (or any other opt-out) to `copillm stop`.
- Real product names or version numbers in `tests/mock-backend/fixtures.ts`.
- Long-lived `console.log` in src/ — use the pino logger.
- Persisting bearer tokens to disk.
- Listening on anything other than loopback.
- Skipping the lint or e2e:pr steps locally.

## When in doubt

When you have questions about coding agents (Codex CLI, Claude Code, etc.), upstream APIs, wire formats, or third-party tooling — **search the web and fetch the current docs before assuming**. These contracts change. Don't rely on training-data snapshots; verify against live documentation, the upstream source repo, or a quick HTTP probe against a real instance, then cite what you found.
