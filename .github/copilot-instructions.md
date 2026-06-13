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
- Tests: `vitest` (unit + integration, laid out to mirror `src/`), custom Node runners for E2E (`tests/e2e/`)
- Logger: `pino` with structured JSON
- Architecture: `src/` is split into layered modules; cross-module imports are enforced by `eslint-plugin-boundaries` (`eslint.config.js`) — see Conventions

## Commands you should use

```bash
npm run build              # tsc -p tsconfig.json
npm run lint               # tsc --noEmit on src/ AND tests/, then eslint src (import-boundary check)
npm run lint:boundaries    # just the eslint-plugin-boundaries layering check on src/
npm test                   # vitest run (unit + integration); globalSetup builds dist/ first
npm run test:e2e:pr        # mock backend + synthetic clients (fast)
npm run test:e2e:release   # mock backend + real Codex + real Claude Code (installs via npx)
node dist/cli.js start --detach    # run the daemon (cli.js is a thin shim over src/cli/)
node dist/cli.js stop              # stop daemon (clears Claude gateway cache too)
node dist/cli.js status            # check daemon + bearer health
```

When you run something on this repo, **prefer the npm scripts above over inferring fresh tooling commands**. `lint` type-checks `tests/` too (via `tsconfig.tests.json`) and runs the import-boundary lint; `test` auto-builds `dist/` via `tests/globalBuild.ts`.

## Repo layout

```
src/
  cli.ts                       # thin shim — just `import "./cli/index.js"`
  cli/                         # the CLI surface (split out of the old monolithic cli.ts)
    index.ts                   # commander entry: registers every command + global flags (--debug, --no-update-notifier)
    commands/
      auth.ts                  # auth login | logout | status  (+ deprecated top-level login/logout)
      daemon.ts                # start | stop | status | health  (+ internal `daemon`)
      models.ts                # models list | select
      env.ts                   # env <agent> — print env vars to launch codex/claude/pi against copillm
      agents/                  # codex.ts claude.ts pi.ts copilot.ts shared.ts — the agent launchers
    configCommands.ts          # config init | show | sync  and  config profile list | use
    daemon/                    # ensureRunning, lifecycle, probes, runDaemon, selfSpawn, spawnEnv
    integrations/              # banner + post-launch native-config refresh (claudeExport, refreshCodex, refreshPi)
    shared/                    # backends, debug, deprecation, exitCodes, output, parseAgent
    launchAgent.ts, resolveAgent.ts, updateNotifier.ts, windowsSpawn.ts, copillmFlags.ts, …
  agents/
    registry.ts                # per-agent capability registry: AgentName-keyed yolo specs + applyYolo()
  auth/                        # GitHub device flow, credential storage, Copilot token manager
  config/
    upstream.ts                # ALL upstream URLs go through here (see "Conventions" below)
    home.ts, config.ts, fsSecurity.ts, logging.ts
  integrations/                # agent-native config writers (moved out of src/codex, src/claude)
    registry.ts                # AgentName union + npm package / bin name per agent (source of truth)
    codex/init.ts              # generates ~/.copillm/codex/config.toml
    claude/cache.ts            # clears ~/.claude/cache/gateway-models.json on stop
    claude/settingsConflict.ts # detects (never writes) ~/.claude/settings.json conflicts
    pi/init.ts                 # pi agent native config
  models/
    discovery.ts               # /models fetch + cache
    anthropicDefaults.ts       # auto-pick latest plain Claude variant per family
  server/                      # split out of the old monolithic proxy.ts
    proxy.ts                   # thin HTTP router: wires routes + request lifecycle
    routes/                    # debug, health, models, proxyForward, shared
    upstream/                  # copilotClient, retryPolicy, streaming
    codexSchema.ts             # isCodexEligible filter for /codex/v1/models
    anthropicModelsResponse.ts # Anthropic-spec /v1/models shape for gateway discovery
    errors.ts, requestLifecycle.ts, debugInfo.ts, lock.ts
  translation/
    openaiAnthropic.ts                  # request body + non-streaming response translation
    streamingOpenAIToAnthropic.ts       # SSE translator (canonical Anthropic event sequence)
  agentconfig/
    schema.ts                           # zod schemas for ~/.copillm/agent.toml (profiles, mcp, yolo)
    load.ts                             # parse + merge defaults + active profile + project overlay, env-expand
    render.ts                           # per-agent renderers (codex/claude/pi/copilot)
    apply.ts                            # orchestrate load → render → write
    markerBlock.ts                      # marker-block upsert + backup-on-drift helpers
  types/index.ts               # shared types — a dependency-free leaf (see the import-boundary layering)
tests/                         # mirrors the src/ layout
  unit/                        # vitest unit tests, grouped by src subtree
  integration/                 # CLI-level integration tests (e.g. integration/authStatusCli.test.ts)
  probes/                      # capability probes
  helpers/                     # shared test harness helpers
  mock-backend/                # standalone HTTP server that mimics Copilot upstream
  e2e/
    pr-gate-runner.ts          # synthetic clients
    release-runner.ts          # real Codex + Claude Code via npx
    clients/                   # codexLikeClient.ts, claudeLikeClient.ts, piLikeClient.ts
.github/
  workflows/pr-gate.yml        # matrix: ubuntu/macos/windows × Node 20/22 (lint + build + unit + e2e:pr)
  workflows/upstream-e2e.yml   # nightly cron + dispatch + invoked by release.yml as the publish gate
  workflows/release.yml        # version-bump triggered: detect → tag → gate → npm publish → GitHub Release
  workflows/docs.yml, docs-pr.yml  # build (+ deploy) the Jekyll docs site
  rulesets/main.json           # blocks direct push to main + force-push + branch deletion
docs/                          # Jekyll site published to jcjc-dev.github.io/copillm
eslint.config.js               # import-boundary layering via eslint-plugin-boundaries (see Conventions)
```

## Conventions (enforce these)

- **Respect the import-boundary layering.** `eslint.config.js` (run by `npm run lint`) treats each `src/` subfolder as an element and disallows cross-element imports except the explicitly-allowed edges. Today's shape: `types` is a dependency-free leaf; `config` → types; `models` and `agentconfig` → config + types; `server` → auth, models, translation, config, types; `integrations` → auth, config, models, server, types; `agents` → integrations; `cli` is the top element and may import anything. Don't add a new cross-element edge just to make something compile — prefer respecting the layering (e.g. park shared types in `src/types`). Widen the allow-map only deliberately, with a comment.
- **Agents are registry-driven — four first-class agents: `codex`, `claude`, `pi`, `copilot`.** The `AgentName` union plus each agent's npm package + bin name live in `src/integrations/registry.ts` (the single source of truth); per-agent runtime behaviour (yolo mapping, …) lives in `src/agents/registry.ts`, keyed by the same union. Adding an agent = one row in each registry + a launcher module under `src/cli/commands/agents/` — never a fresh `if (agent === …)` branch in a handler.
- **`--yolo` resolves through a precedence chain, never hardcoded at a call site.** Highest wins: `--yolo` flag → `COPILLM_YOLO` env (tri-state — explicit `0`/`false`/`no` vetoes config-driven yolo) → `agent.toml` `[profiles.<active>.yolo].agents.<agent>` → `.yolo.enabled` → off. Per-agent translation lives in `applyYolo` (`src/agents/registry.ts`): claude `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`, copilot `--allow-all`, pi unsupported (warns, forwards argv unchanged). Route decisions through `resolveYoloWithSource` + `applyYolo` so the unsupported-agent warning keeps its source attribution.
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
- **`auth status` and the `status.auth` block never print the token.** They use `inspectStoredCredential()` (which reports presence + backend only), not `loadStoredCredential()` (which returns the token). `tests/integration/authStatusCli.test.ts` enforces this with a substring-leak guard. Don't wire status surfaces through `loadStoredCredential`.
- **Unified agent config lives in TOML at `~/.copillm/agent.toml` (global) and `<cwd>/.copillm/agent.toml` (project overlay).** It is profile-structured: `active_profile` selects a profile, `[defaults.*]` always applies, and `[profiles.<name>.*]` overrides same-keyed defaults; v1 wires `instructions`, `mcp`, and `yolo`, while `skills`/`agents`/`hooks`/`permissions` are reserved-but-permissive (validated, not yet rendered). The loader (`src/agentconfig/load.ts`) fails closed on duplicate TOML keys, schema violations, unresolved `${VAR}` expansions, and `mcpServers` name collisions between copillm-managed and user-owned entries. Renderers (`src/agentconfig/render.ts`) MUST preserve user-owned entries: Claude's `.mcp.json` keeps unrelated `mcpServers.*` and tracks copillm-owned names in a sibling `_copillmManaged` array; AGENTS.md / CLAUDE.md use the `<!-- copillm:managed begin -->` … `<!-- copillm:managed end -->` marker block. Compute every FileWrite in memory before touching disk — no partial writes on error.

## Test fixtures and naming

- Tests mirror `src/`: unit tests in `tests/unit/<subtree>/`, CLI-level tests in `tests/integration/`, shared harness code in `tests/helpers/`, the mock upstream in `tests/mock-backend/`, and the E2E runners in `tests/e2e/`. Put a new test next to the layer it exercises.
- All fictional models in `tests/mock-backend/fixtures.ts` use deliberately generic names: `claude-test-opus`, `claude-test-sonnet`, `claude-test-haiku`, `gpt-test`, `gpt-test-codex`. **Do not introduce real product names or version numbers in test fixtures.**
- Test runs are hermetic: spawn the mock backend, seed a tmpdir-backed `COPILLM_HOME` with a fake GitHub token, point copillm at the mock via env-var overrides. Never make a test require real Copilot credentials.
- `COPILLM_FORCE_SESSION_BACKEND=1` is a test-only seam that short-circuits the keychain detection in `src/auth/credentials.ts` and disables the plaintext-fallback gate, forcing the `auth login` flow to land on the in-memory `"session"` backend. Useful for exercising the session path deterministically on machines with a working keychain. Also exposed as a hidden `--force-session` flag on `auth login`. Not documented in the user-facing README.

## PR / commit workflow

- **Start every change in a fresh git worktree synced to the latest `main`.** Multiple agents work this repo concurrently, so never edit in place on a shared checkout. Before you start: `git fetch origin`, then `git worktree add -b <type>/<slug> .claude/worktrees/<slug> origin/main` (worktrees live under the gitignored `.claude/worktrees/`). Always pull/sync the latest `main` first so your branch is based on current `origin/main`, not a stale local copy.
- **Always raise a PR; never push or merge directly to `main`.** A ruleset config sits at `.github/rulesets/main.json` to formalize this, but it is not actively enforced on this private repo, so discipline is on us. Branch off `main`, push your feature branch, and open a PR — every time, including for trivial changes.
- **Always rebase your feature branch onto latest `origin/main` before opening a PR.** Concurrent agents mean `main` may have moved since you branched; conflicts here are usually trivial (different subtrees) but check anyway.
- **Run the full local pipeline before pushing**: `npm run lint && npm test && npm run test:e2e:pr`. The PR-gate workflow runs the same on every push to a 6-cell matrix.
- **After pushing, watch CI in the background — don't block on it.** Spawn `gh pr checks <number> --watch` as an asynchronous/detached task using whatever background-execution primitive your environment provides (agent background-task tools, scheduled re-prompts, `setsid` / `nohup … &`, a detached shell session, etc.) so it can notify you when the matrix resolves rather than holding the session open. Fall back to a foreground `gh pr checks <number> --watch` only when no async mechanism is available. Either way, the work isn't finished until every matrix cell is green — if any cell fails, surface the failure to the user and fix it before handing off. Don't declare the task done while runs are queued or in-progress unless a background watcher is in place that will report the outcome back to the user when it resolves.
- **Commit messages**: imperative subject ≤ 72 chars, blank line, then a body explaining the *why*. End with the project's `Co-authored-by: Copilot <...>` trailer when AI-assisted (handled by tooling, do not strip).
- **PR titles** match commit subjects when there's one logical change. Use prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.
- **Squash-merge** is the default. Branches auto-delete after merge.

## Cutting a release

The release pipeline is fully automated by `.github/workflows/release.yml`. **Do not** run `npm version`, `git tag`, `gh release create`, or `npm publish` locally — `release.yml` does all of that.

To ship a new version:

1. Branch off `main` and bump `version` in both `package.json` and `package-lock.json` (keep them in sync — both the top-level `version` and the `packages[""].version` inside `package-lock.json`). **Default to a patch bump.** Unless the user explicitly directs otherwise, every release is a patch — minor/major bumps are reserved for significant behavior changes, repo restructures, or new/breaking functionality, and should be confirmed with the user before bumping. Standard semver still applies inside that policy: patch for fixes, minor for backward-compatible features, major for breaking changes.
2. Optionally include the user-facing changes in the same PR, or land them separately first. If the version bump is its own PR, give it a `chore(release): vX.Y.Z` title.
3. Open the PR, wait for `pr-gate` to go green across all 6 matrix cells, get it merged to `main`.
4. On merge, `release.yml` fires automatically because `package.json` changed. It runs **detect → tag → upstream-e2e gate → npm publish → GitHub Release** linearly. Watch the workflow run; if any step fails, the npm push is skipped and you can investigate without a broken artifact landing on the registry.
5. Verify `npm view copillm@<version>` returns the new version and the GitHub Release exists with auto-generated notes.

Notes:

- The `detect` job is idempotent — if the tag already exists (because `release.yml` already ran for this version), downstream jobs skip. Safe to re-run via `workflow_dispatch` for retries.
- The gate (`upstream-e2e.yml`) installs the **real** `@openai/codex` and `@anthropic-ai/claude-code` packages and drives them through copillm. A failure here usually means either (a) a Windows arg-quoting / shell-escaping issue in the e2e harness, or (b) an actual upstream regression — investigate before bumping again.
- If `release.yml` fails after the tag is pushed but before npm publishes, you cannot simply re-run for the same version; either bump again or manually delete the tag + dispatch.
- Never publish to npm by hand. The repo relies on npm OIDC trusted publishing with provenance via the `npm-publish` GitHub Environment — local `npm publish` would bypass both the gate and the provenance attestation.

## Debug / identifying issues

When investigating a misbehaving request or daemon, prefer the built-in debug surface before adding new instrumentation.

- **Global `--debug` flag.** `copillm --debug <subcommand>` (e.g. `copillm --debug start`, `copillm --debug claude`) enables daemon debug mode for that invocation: it turns on `/_debug`, sets the daemon log level to `debug`, and (for detached daemons) writes structured JSON logs to a debug log file. Per-command `--debug` / `--copillm-debug` flags are retained as compatibility aliases — keep `--copillm-debug` on launchers so child-agent `--debug` flags pass through cleanly.
- **Debug log file.** Detached debug daemons write to `~/.copillm/debug.log` by default; override with `COPILLM_LOG_FILE`. The file is created with `0600` perms. Foreground daemons write to stderr (see below).
- **Daemon logs go to stderr, not stdout.** Command stdout stays clean for `--json` consumers and banners; structured pino logs flow to fd 2 (or to `COPILLM_LOG_FILE` when set). Don't reintroduce `console.log` in daemon code paths.
- **`/_debug` endpoint.** Only mounted when debug mode is on. Returns `server.{port,pid,uptime_seconds,log_level,log_file,...}`, `auth.{bearer_ttl_seconds,bearer_present,...}`, the GitHub user summary, and the route list. The bearer token is never included. Add new diagnostic fields here rather than logging them ad-hoc.
- **Upstream error forwarding is part of the default contract, not a debug-mode feature.** When upstream returns non-2xx, the proxy forwards a structured payload to the client: Anthropic routes get `{ type: "error", error: { type, code, message, upstream_status_code, request_id } }`; OpenAI-shape routes get the same fields under `error`. **The HTTP status returned to the client mirrors `upstream.status`** (e.g. upstream 429 → client 429). Don't collapse this back to a generic 400/500.
- **Useful log events.** `event=http_request` (info), `event=upstream_non_ok` (warn, carries `upstream_error_code` + `upstream_error_message`), `event=upstream_retry` (warn), `event=request_prepared` and `event=upstream_request` / `event=upstream_response` (debug only). When adding new diagnostics that are noisy or expose request shape, gate them on `logger.debug` so they only appear under `--debug`.
- **Probing manually.** `copillm --debug start --detach` then `curl http://127.0.0.1:<port>/_debug | jq` is the canonical first step. `copillm status --json` is fine for liveness but does not require debug mode.

## Things to avoid

- Adding a third-party HTTP client — use Node's built-in `fetch`.
- Hardcoding URLs — go through `src/config/upstream.ts`.
- Adding a cross-module import that forces you to widen `eslint.config.js`'s boundary allow-map just to compile — respect the layering instead.
- Branching on agent name inside a handler instead of extending `src/integrations/registry.ts` + `src/agents/registry.ts`.
- Writing into `~/.claude/settings.json` or `~/.codex/config.toml` from copillm code. We document env-var workflows and don't write into other tools' config; `src/integrations/claude/settingsConflict.ts` only *detects* conflicts. (Evicting the Claude gateway model *cache* on `stop` is the one deliberate exception.)
- Adding a `model_catalog.json` file or `model_catalog_json` TOML key for Codex — discovery is live.
- Adding `--keep-claude-cache` (or any other opt-out) to `copillm stop`.
- Real product names or version numbers in `tests/mock-backend/fixtures.ts`.
- Long-lived `console.log` in src/ — use the pino logger.
- Persisting bearer tokens to disk.
- Listening on anything other than loopback.
- Skipping the lint or e2e:pr steps locally.

## When in doubt

When you have questions about coding agents (Codex CLI, Claude Code, etc.), upstream APIs, wire formats, or third-party tooling — **search the web and fetch the current docs before assuming**. These contracts change. Don't rely on training-data snapshots; verify against live documentation, the upstream source repo, or a quick HTTP probe against a real instance, then cite what you found.
