# Local LLM Proxy CLI — Specification

A standalone, command-line tool that turns a user's GitHub Copilot subscription
into one or more **locally exposed** endpoints — each endpoint speaking either
the OpenAI or Anthropic wire protocol — so that any compatible coding agent or
SDK on the user's machine can use Copilot models without separate API keys.

The tool is independent: it does not depend on, embed into, or require any
desktop application. It is started, stopped, and inspected entirely through
its CLI surface.

---

## 1. Vision

The user runs a single command. After a one-time interactive login with their
GitHub account, the tool starts a background-capable local process that:

- Discovers which Copilot models that GitHub account is entitled to.
- Lets the user pick which of those models to expose.
- Serves each chosen model behind a local-only HTTP endpoint.
- Translates between protocol shapes (OpenAI ⇄ Anthropic) on demand.
- Forwards requests to the upstream Copilot service with appropriate
  short-lived credentials, refreshing them transparently.

The tool is offline-first for invocation: once logged in, no further user
interaction is required across machine restarts.

---

## 2. Goals & Scenarios to Pass

Every item below is a **hard acceptance criterion**. The implementer is free
to choose any technology to satisfy them, but must satisfy all of them.

### 2.1 Endpoint exposure

- **G1.** When the tool is running, the local endpoints MUST be reachable
  only from the same machine. A request originating from any other host on
  the network MUST receive no response (connection refused or equivalent).
- **G2.** It MUST be impossible to start the tool in a mode that binds to a
  network-reachable interface. There is no flag, environment variable, or
  config field that opts out of localhost-only binding.
- **G3.** Each exposed model MUST be reachable in **both** an OpenAI-compatible
  and an Anthropic-compatible shape, regardless of whether the upstream model
  is natively OpenAI-style or Anthropic-style. The user does not need to know
  which "native" family a model belongs to.
- **G4.** Streaming and non-streaming responses MUST both work for every
  exposed model in every supported protocol shape.
- **G5.** Tool-calling / function-calling MUST be preserved across
  translation in both directions.
- **G6.** Image inputs MUST be preserved across translation when the chosen
  model supports them.

### 2.2 Authentication & credentials

- **G7.** Initial login MUST use an interactive OAuth flow that works in a
  pure terminal environment (i.e. does not require a graphical app, but MAY
  open a browser if one is available).
- **G8.** After the first successful login, subsequent invocations of the
  tool — including after machine restart — MUST start without prompting the
  user to log in again, until the user explicitly logs out or the upstream
  invalidates the credential.
- **G9.** The long-lived user credential MUST be stored in the operating
  system's standard secure credential store. It MUST NOT be written to any
  plaintext file, log, environment dump, or shell history.
- **G10.** The short-lived bearer used to call the upstream API MUST live
  only in process memory. It MUST NOT be persisted to disk, logs, or the
  credential store.
- **G11.** The tool MUST refresh the short-lived bearer ahead of expiry
  without dropping in-flight requests, and MUST recover automatically from
  an upstream "unauthorized" response by force-refreshing and retrying once.
- **G12.** A clean logout command MUST exist that (a) revokes or removes the
  stored long-lived credential, (b) wipes any in-memory bearer, and (c)
  causes the next request to fail with a clear "not authenticated" message
  rather than silently using stale state.

### 2.3 Model discovery & selection

- **G13.** The tool MUST be able to enumerate the models the logged-in
  account is currently entitled to use, by querying the upstream provider
  rather than relying on a hardcoded list.
- **G14.** The user MUST be able to choose which of the discovered models to
  expose locally (e.g. all, a named subset, or interactively pick).
- **G15.** A model that exists upstream but is not selected MUST NOT be
  reachable through the local proxy.
- **G16.** When the user selects a model under one naming convention but the
  upstream offers it under a slightly different one (versioned aliases,
  date-stamped snapshots, marketing names vs. API IDs), the tool MUST
  resolve the user's choice to a real, currently-available upstream model.
  This resolution MUST NOT depend on a hardcoded mapping table that
  silently goes stale; it MUST consult the live model list.

### 2.4 Security posture

- **G17.** Binding MUST be to the loopback interface only. Any attempt to
  bind to a non-loopback address MUST fail with an explicit error.
- **G18.** The tool MUST NOT expose its endpoints over an unauthenticated
  port to *other local users* on a multi-user machine without an explicit
  per-process secret that callers must present. (See requirement R-Auth-1
  in §6.)
- **G19.** Logs MUST never contain credentials, bearers, full request bodies
  containing user content, or upstream response bodies. Redaction MUST be
  the default; opting in to verbose logging MUST require an explicit flag
  AND MUST still redact credential material.
- **G20.** The tool MUST NOT make outbound network calls to any host other
  than (a) the GitHub identity / OAuth host, (b) the GitHub Copilot API
  host, and (c) hosts the user explicitly configures. No telemetry, no
  analytics, no auto-update beacons by default.
- **G21.** When an upstream call fails, the error returned to the local
  caller MUST preserve the upstream status code semantics (auth, rate
  limit, bad request, server error) but MUST NOT echo the raw upstream
  body if it could contain credentials or other request material.

### 2.5 Process lifecycle

- **G22.** The tool MUST be runnable as a foreground process (logs to
  terminal, Ctrl-C stops cleanly) and as a detached background process
  (started and stopped via subcommands).
- **G23.** Stopping the tool MUST close listening sockets, drain in-flight
  requests within a bounded time, and release the credential bearer from
  memory.
- **G24.** Two instances of the tool started by the same user on the same
  machine MUST either (a) cooperate (second instance attaches to the
  first), or (b) refuse to start with a clear error pointing at the
  running instance. They MUST NOT silently race over the same port or
  credential entry.
- **G25.** A crash or kill -9 MUST NOT leave the credential store in an
  inconsistent state, and MUST NOT leave port allocations or lockfiles
  that prevent the next start.

### 2.6 Operability

- **G26.** A status command MUST report: whether the tool is running, what
  port(s) it is bound to, which models are exposed, which protocol shapes
  each is exposed in, the authenticated account name, and the time until
  the in-memory bearer next refreshes.
- **G27.** A health check endpoint MUST exist at a well-known local path
  that returns success only when the tool can currently obtain a valid
  upstream bearer. Compatible agents and supervisors can use this to know
  the proxy is actually usable, not just listening.
- **G28.** Startup MUST not require network access *if* a valid bearer is
  already cached in memory from a still-running prior process; cold start
  MAY require network access for the credential exchange.

### 2.7 Compatibility contract

- **G29.** A request that conforms to a published OpenAI request shape for
  the chosen model MUST receive a response that conforms to the
  corresponding published OpenAI response shape — including streaming
  event names, ordering, and terminator semantics.
- **G30.** Same as G29 but for the Anthropic shape.
- **G31.** Stream event identifiers MUST be internally consistent within a
  single response (i.e. an SDK that correlates events by ID MUST NOT see
  IDs change mid-stream), even if the upstream provider is itself
  inconsistent. The proxy is responsible for normalizing.

---

## 3. Non-Goals

- Not a multi-tenant service. Single user, single machine, single account.
- Not a billing or quota manager. The user's upstream entitlement is the
  only quota; the proxy does not impose its own.
- Not a model router that picks a model for the caller. The caller asks for
  a specific model; the proxy resolves and forwards.
- Not a fine-tuning, embedding-management, or vector-store tool.
- Not a content moderation layer. Pass-through, with redaction in logs only.
- Not a generic "run any LLM locally" tool. Scope is the GitHub-account-
  entitled Copilot models only.

---

## 4. User Flow

### 4.1 First-time setup

1. User installs the binary.
2. User runs the login subcommand.
3. The tool initiates an interactive OAuth flow suitable for the terminal,
   showing a short user code and a verification URL, optionally opening a
   browser.
4. The user completes verification on GitHub.
5. The tool stores the resulting long-lived credential in the OS secure
   credential store and confirms success.

### 4.2 Configuring exposure

1. User runs a discovery subcommand to list available models for their
   account.
2. User runs a select / configure subcommand to pick which models to expose
   and (optionally) which protocol shapes each should be available under.
   By default, every selected model is exposed in **both** shapes.
3. The selection is persisted (not the credentials — just the user's
   choices).

### 4.3 Running

1. User runs the start subcommand (foreground or detached).
2. The tool reads the persisted selection, restores the long-lived
   credential from the secure store, exchanges it for a fresh short-lived
   bearer, binds local-only listening sockets, and prints the local URLs
   for each model and shape.
3. The user points their coding agent / SDK at one of those URLs.

### 4.4 Steady state

1. The user closes their laptop, opens it later, restarts the machine, etc.
2. They run the start subcommand again. No login prompt appears. The tool
   restores credentials from the OS store, refreshes the bearer, and is
   ready.

### 4.5 Logout

1. User runs the logout subcommand.
2. The credential is removed from the OS store, the in-memory bearer is
   wiped, listeners are closed, and the next start subcommand will require
   re-login.

---

## 5. Per-Request Flow (system view)

For each incoming request to a local endpoint:

1. Verify the request originated locally (loopback only) — if not, reject.
2. Verify the per-process caller secret if one is configured — if invalid,
   reject with an authentication error.
3. Identify which protocol shape the request is in (OpenAI or Anthropic),
   based on the endpoint path or content shape.
4. Identify the requested model. Resolve the request's model name against
   the live list of upstream-available models for the current account.
   If no resolution is possible, reject with a clear "model not available"
   error that names the closest available alternatives.
5. If the request shape differs from the model's native upstream shape,
   translate the request, preserving system instructions, message ordering,
   tool definitions, tool call results, and any image content.
6. Apply pre-flight size guards: estimate the effective context size; if
   it exceeds the upstream limit for that model, truncate oldest non-system
   content and clean up any tool-call references that become orphaned by
   truncation. Never silently drop the most recent user turn.
7. Acquire a current valid short-lived bearer; refresh in-line if it is
   within the safety margin of expiry.
8. Forward to the upstream provider over HTTPS, attaching the bearer and
   any provider-required identification headers.
9. On a transient upstream failure (timeout, connection error, rate limit,
   server error, authentication failure), retry with bounded exponential
   backoff up to a small fixed maximum. On authentication failure
   specifically, force a credential refresh before the retry.
10. If the response is streamed, translate streaming events on the fly into
    the caller's protocol shape, normalizing event identifiers to remain
    internally consistent across the whole stream.
11. If the response is non-streaming, translate the body in full.
12. Return to the caller. Log only the request metadata (timestamp, model,
    shape, status, byte counts, latency) — never the body.

---

## 6. Functional Requirements (non-acceptance, descriptive)

- **R-Discovery-1.** The tool MUST refresh its cached model list on a
  bounded schedule and on demand via a CLI subcommand. Cache staleness
  MUST never cause a request to be rejected if the upstream still
  recognizes the model.
- **R-Discovery-2.** If the upstream is unreachable when discovering
  models, the tool MUST fall back to the last known good list (with a
  visible "stale" indicator in status output) rather than presenting an
  empty list.
- **R-Auth-1.** The tool MUST support an optional per-process caller
  secret. When enabled, every local request must present this secret
  (e.g. as a bearer header) or be rejected. The secret MUST be generated
  fresh per process start, printed to the operator once at startup, and
  never persisted.
- **R-Auth-2.** The tool MUST detect the case where the long-lived
  credential is present but no longer accepted by the upstream, and MUST
  surface this clearly (status output + structured error to callers)
  rather than entering an infinite refresh loop.
- **R-Translate-1.** Translation MUST be lossless for content the target
  protocol can express. For content the target protocol cannot express
  (e.g. a feature only one side supports), the tool MUST either degrade
  predictably and document the degradation, or refuse the request with a
  clear error — never silently corrupt the message.
- **R-Translate-2.** Model name resolution rules MUST be defined as data,
  not code branches per model. Adding a new model alias upstream MUST NOT
  require a code change in the tool.
- **R-Lifecycle-1.** The tool MUST emit structured logs with stable field
  names so an operator can grep and a supervisor can parse them.
- **R-Lifecycle-2.** Configuration files (selection, preferred port,
  caller-secret policy) MUST live under the user's per-application
  config directory according to the OS convention. They MUST be created
  with user-only read/write permissions.
- **R-Lifecycle-3.** The tool MUST handle the case where its preferred
  port is already taken (by itself from a prior crash, or by an unrelated
  process) by attempting a small number of alternates and printing the
  actual chosen port clearly.

---

## 7. CLI Surface (illustrative — names are placeholders)

The tool exposes subcommands. The exact names are an implementation
choice; the *capabilities* below are required.

| Capability | Purpose |
|---|---|
| login | Run interactive OAuth, store long-lived credential. |
| logout | Remove long-lived credential, stop tool, wipe memory. |
| status | Show running state, port, exposed models, account, bearer TTL. |
| models list | Print models the account can use right now. |
| models select | Choose which models to expose and in which shape(s). |
| start | Launch the proxy (foreground or detached). |
| stop | Stop a detached instance. |
| health | Exit 0 iff the running instance can currently obtain a bearer. |
| version | Print build and protocol-compatibility versions. |

Every subcommand MUST have a `--json` machine-readable output mode for
scripting, in addition to its human-readable default.

---

## 8. Persisted vs. Ephemeral State

| Item | Where | Lifetime |
|---|---|---|
| Long-lived user credential | OS secure credential store | Until logout / revocation |
| Selected models & shape preferences | Per-user config file (user-only perms) | Until user changes them |
| Preferred port | Per-user config file | Until user changes them |
| Short-lived bearer | Process memory only | Process lifetime |
| Per-process caller secret (if enabled) | Process memory only | Process lifetime |
| Cached model list | Process memory + optional best-effort on-disk snapshot for cold-start fallback (no credentials, no user content) | Refreshed on schedule and on demand |
| Logs | OS-conventional log location, redacted | Subject to user-controlled rotation |

---

## 9. Open Decisions for the Implementer

These are intentionally left open. Any choice that satisfies §2 is
acceptable.

1. Whether the tool exposes one port serving many models via path routing,
   or one port per model, or both.
2. Whether the detached background mode is implemented via fork, a
   supervisor subcommand, or platform-native service registration.
3. Whether the per-process caller secret defaults to enabled or disabled
   on a single-user machine. (Recommendation: disabled by default with a
   loud warning when running on a machine that has more than one
   interactive user account; enabled by default otherwise.)
4. The exact names of subcommands and flags.
5. Whether streaming translation buffers minimally for correctness or
   passes events through with rewrites only.
6. The exact backoff schedule, within the bounds of "small fixed maximum"
   and "bounded total added latency".

---

## 10. Definition of Done

The tool is "done" for v1 when, on a clean machine with only the GitHub
account credentials available:

1. A user can install the binary, run one command to log in, run a second
   command to start the proxy, and immediately use a stock OpenAI SDK and
   a stock Anthropic SDK pointed at the printed local URLs to chat with at
   least one Copilot-entitled model in each shape, including streaming
   and tool calls.
2. They can close their laptop, reopen it the next day, run the start
   command, and have working endpoints again with no re-login.
3. From another machine on the same LAN, no port scan or direct request
   reaches the proxy.
4. Logs after a session contain no credentials, no message bodies, and
   no upstream response bodies.
5. All scenarios in §2 pass an automated test suite.

---

## 11. Implementation Addendum (Build-Ready Specifics)

This section closes gaps left open in §9 with concrete, verified facts so the
implementer can build without further discovery. Where a value is dictated by
an external system (GitHub, Anthropic, OpenAI), it is stated as observed at
spec time; the tool MUST treat any of these as overridable via configuration
to avoid breakage if upstream changes.

### 11.1 Upstream Copilot API Contract

The upstream is the same private API used by the official VS Code Copilot
Chat extension. Endpoints, hosts, and headers below match what that
extension sends.

**Hosts** (selected based on the user's account type; see G13 / R-Discovery):

| Account type | Base URL |
|---|---|
| individual | `https://api.githubcopilot.com` |
| business   | `https://api.business.githubcopilot.com` |
| enterprise | `https://api.enterprise.githubcopilot.com` |

**Endpoints used by this tool:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/chat/completions` | Primary inference endpoint. OpenAI Chat Completions request shape; OpenAI-style SSE response. Used for **all** exposed models, including those marketed as Anthropic models — the upstream normalizes them to OpenAI shape. |
| `GET`  | `/models` | Live entitled-model list with capabilities (see §11.6). Used to satisfy G13/G16/R-Translate-2. |
| `POST` | `/embeddings` | Optional; only enabled if user selects an embedding model. |

**Token-exchange endpoint** (long-lived GitHub token → short-lived Copilot
bearer; see G10/G11):

```
GET https://api.github.com/copilot_internal/v2/token
Authorization: token <GITHUB_OAUTH_TOKEN>
<standard headers below>
```

Response is JSON containing at least `token` (the short-lived bearer) and
`expires_at` (unix seconds). The bearer typically lives ~25 minutes; the
tool MUST refresh when remaining TTL drops below 5 minutes (G11) and on any
401 from the inference endpoint (force-refresh + single retry).

**Required headers on every Copilot request** (omitting any of these has
been observed to produce 400/401):

| Header | Value |
|---|---|
| `Authorization` | `Bearer <copilot_token>` |
| `Content-Type` | `application/json` |
| `Copilot-Integration-Id` | `vscode-chat` |
| `Editor-Version` | `vscode/<vscode_version>` (e.g. `vscode/1.95.0`) |
| `Editor-Plugin-Version` | `copilot-chat/<plugin_version>` (e.g. `copilot-chat/0.26.7`) |
| `User-Agent` | `GitHubCopilotChat/<plugin_version>` |
| `Openai-Intent` | `conversation-panel` |
| `X-GitHub-Api-Version` | `2025-04-01` |
| `X-Request-Id` | fresh UUIDv4 per request |
| `X-VScode-User-Agent-Library-Version` | `electron-fetch` |
| `Copilot-Vision-Request` | `true` — only when request contains image input |

The VS Code and plugin version strings MUST be configurable. The tool
SHOULD periodically (best-effort, non-blocking) refresh them from the
public VS Code release feed and the public Copilot Chat marketplace
listing; on failure, fall back to a baked-in default that is updated each
release of this tool.

### 11.2 OAuth / Login Flow

Use **GitHub OAuth Device Flow** (RFC 8628 style). This works in pure
terminals and does not require a browser-callback listener.

| Field | Value |
|---|---|
| Client ID | `Iv1.b507a08c87ecfe98` (the GitHub-issued client ID for Copilot in editors) |
| Device-code endpoint | `POST https://github.com/login/device/code` |
| Token-poll endpoint  | `POST https://github.com/login/oauth/access_token` |
| Scope | `read:user` |
| Grant type (poll) | `urn:ietf:params:oauth:grant-type:device_code` |

Standard flow:

1. `POST /login/device/code` with `client_id` and `scope`. Receive
   `device_code`, `user_code`, `verification_uri`, `expires_in`,
   `interval`.
2. Display `user_code` and `verification_uri` to the user; optionally open
   the browser to `verification_uri` (do not depend on it succeeding).
3. Poll `/login/oauth/access_token` at `interval` seconds with
   `client_id`, `device_code`, and the device-code grant type. Handle
   `authorization_pending`, `slow_down`, `expired_token`, `access_denied`
   per RFC 8628.
4. On success, persist the returned `access_token` (the long-lived
   credential) to the OS secure store per G9.

The Client ID above is not a secret — it is shipped in the public VS Code
extension. No client secret is involved (device flow does not use one).
GitHub does NOT issue a refresh token for this flow; the long-lived
`access_token` is used directly until the user logs out or GitHub
invalidates it.

### 11.3 Translation Mapping (OpenAI ⇄ Anthropic)

Because the upstream `/chat/completions` endpoint always speaks OpenAI
shape, **OpenAI is the canonical internal shape**. Anthropic-shape inbound
requests are translated to OpenAI before forwarding, and OpenAI-shape
upstream responses are translated to Anthropic events on the way back.

**Field-level mapping (request):**

| Anthropic (`POST /v1/messages`) | OpenAI (`POST /chat/completions`) |
|---|---|
| `model` | `model` (after resolution per §5 step 4) |
| `system` (string or content-block array) | prepended `messages[0]` with `role: "system"`; multiple system blocks concatenated with `\n\n` |
| `messages[].role: "user"` | `messages[].role: "user"` |
| `messages[].role: "assistant"` | `messages[].role: "assistant"` |
| Content block `text` | string content, or `content[].type: "text"` |
| Content block `image` (`source.type: base64`) | `content[].type: "image_url"` with `image_url.url = "data:<media_type>;base64,<data>"` |
| Content block `tool_use` (assistant) | `messages[].tool_calls[]` with `id`, `type: "function"`, `function.name`, `function.arguments` (stringified JSON of `input`) |
| Content block `tool_result` (user) | a separate message `role: "tool"`, `tool_call_id: <tool_use_id>`, `content: <stringified result>` |
| `tools[]` (`name`, `description`, `input_schema`) | `tools[]` with `type: "function"`, `function.{name, description, parameters}` |
| `tool_choice: {type: "auto"}` | `tool_choice: "auto"` |
| `tool_choice: {type: "any"}` | `tool_choice: "required"` |
| `tool_choice: {type: "tool", name}` | `tool_choice: {type: "function", function: {name}}` |
| `tool_choice: {type: "none"}` | `tool_choice: "none"` |
| `max_tokens` (required) | `max_tokens` |
| `temperature`, `top_p`, `stop_sequences` | `temperature`, `top_p`, `stop` |
| `stream: true` | `stream: true` |
| `metadata.user_id` | `user` |
| `thinking.*` blocks | **degrade**: stripped from request; documented in README. |

**Field-level mapping (non-streaming response, OpenAI → Anthropic):**

| OpenAI | Anthropic |
|---|---|
| `id` | `id` (rewritten to `msg_<base64url(uuid)>` for stable identity) |
| `model` | `model` |
| `choices[0].message.content` (string) | one `content[]` block of `type: "text"` |
| `choices[0].message.tool_calls[]` | one `content[]` block of `type: "tool_use"` per call (`id`, `name`, `input` parsed from `function.arguments`) |
| `choices[0].finish_reason` → Anthropic `stop_reason` | `stop` → `end_turn`; `length` → `max_tokens`; `tool_calls`/`function_call` → `tool_use`; `content_filter` → `refusal` |
| `usage.prompt_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |
| (always) `role` | `role: "assistant"`, `type: "message"` |

**Streaming mapping:** the OpenAI-shape upstream emits a single sequence of
`chat.completion.chunk` SSE events terminated by `data: [DONE]`. The
Anthropic shape requires the structured event flow defined by Anthropic
(`message_start`, then per content block `content_block_start` /
`content_block_delta` / `content_block_stop`, then `message_delta`, then
`message_stop`, with optional `ping`). The translator MUST:

1. Synthesize `message_start` from the first chunk that carries `id`,
   `model`, and `role`. The Anthropic `message.id` MUST be assigned once
   here and reused for the entire stream (G31 normalization).
2. Track an `index` counter starting at 0. Open a `text` content block on
   first `delta.content` text; emit `content_block_start` then
   `content_block_delta` (`text_delta`) per chunk; emit
   `content_block_stop` when the content channel transitions to a
   different type or stream ends.
3. For `delta.tool_calls`, open one `tool_use` content block per
   `tool_calls[].index`, emitting `content_block_start` with the `id` and
   `name`, then `content_block_delta` (`input_json_delta`,
   `partial_json`) for each `function.arguments` fragment, then
   `content_block_stop` when that tool call's index goes silent or the
   stream ends.
4. On the chunk carrying `finish_reason`, close any open block, emit
   `message_delta` with mapped `stop_reason` and `usage`, then
   `message_stop`. The upstream `data: [DONE]` is consumed and dropped.
5. `ping` events MAY be emitted on a timer if the upstream stalls, to
   keep the SDK alive. Never invent content.

**Reverse direction** (caller speaks OpenAI; upstream is OpenAI): pass-
through with one rewrite — the response `id` MUST be stable for the whole
stream (G31). If upstream emits inconsistent IDs across chunks, the proxy
overwrites with the first-seen ID.

**Lossy degradations** (R-Translate-1 — must be documented in README):

- Anthropic `thinking` content blocks: stripped on request; not
  synthesized on response.
- Anthropic `cache_control` ephemeral hints: ignored.
- Anthropic server-tool blocks (`web_search`, `code_execution`, etc.):
  rejected with a clear `unsupported_feature` error.
- OpenAI `logprobs`, `n > 1`, `response_format: json_schema` strict mode,
  `seed`: forwarded as-is; behavior depends on upstream model and is not
  guaranteed.

**Data-driven model resolution (R-Translate-2):** a YAML file shipped with
the binary defines aliasing rules as patterns, not per-model branches:

```yaml
# resolution.yaml — illustrative
rules:
  - match: "^claude-3-5-sonnet.*"
    prefer: ["claude-3.5-sonnet", "claude-sonnet-3.5"]
  - match: "^gpt-4o(-.*)?$"
    prefer: ["gpt-4o"]
fallback: closest-by-prefix
```

Resolution always validates the chosen ID against the live `/models`
response.

### 11.4 Concurrency & Locking (G24/G25)

- **Single-instance lock:** a per-user PID file at
  `<config_dir>/copilot-proxy.pid` containing `{pid, port, started_at_iso,
   bearer_token_id}`. The token ID is a hash of the in-memory bearer's
  `jti`-equivalent for sanity, never the bearer itself.
- **Acquire:** open the file `O_CREAT | O_EXCL` with mode `0600`. On
  collision, read it; if the recorded PID is alive (per OS-native check)
  and its port is reachable on loopback with our health probe, exit 0
  with "already running at http://127.0.0.1:<port>". Otherwise the lock
  is stale: unlink and retry once.
- **Release:** unlink on graceful shutdown. On crash, the next start
  detects the stale lock per above (G25). Never use advisory file locks
  (`flock`) alone — they don't survive process death cleanly on all
  platforms.
- **Port allocation (R-Lifecycle-3):** preferred port from config (default
  `4141`); on `EADDRINUSE`, try `4142..4150` then fail with the explicit
  conflicting PID if findable.
- **Credential-store contention:** all reads/writes to the OS keychain
  go through a single in-process mutex. No cross-process keychain locking
  is needed because only one instance runs.

### 11.5 Platform Targets & Distribution (closes §9.4 and original gap #4)

The project name is **copillm**. The tool ships as a single self-contained
binary for each of the following targets:

- macOS: `arm64`, `x86_64` (signed and notarized; default credential
  backend is Keychain Services via the OS-native API)
- Windows: `arm64`, `x86_64` (default credential backend is Windows
  Credential Manager via `wincred`)
- Linux: `arm64`, `x86_64` (default credential backend is Secret Service
  via `libsecret` D-Bus when available)

#### 11.5.1 Credential backends & the `~/.copillm/` file fallback

There are exactly two credential backends, in this order of preference:

1. **OS secure credential store** — the platform-native backend listed
   above. This is the default on any machine where it is reachable.
2. **Plaintext file at `<copillm-home>/credentials.json`** — a
   cross-platform fallback. **Not Linux-specific.** It is used in two
   distinct situations:
   - **Auto-fallback during `login`** when no OS keyring is reachable
     (e.g. headless Linux, locked-down Windows containers, macOS
     running without a logged-in GUI session). In this case the tool
     follows industry-standard practice (similar to `gh`,
     `docker login`, `aws configure`) and **prompts the user
     interactively** before writing plaintext:
     - The file will be readable by anyone with access to the user's
       home directory or filesystem backups.
     - Anyone who reads the file can use the token to act as the user
       against GitHub Copilot.
     - The file is created with mode `0600` and the directory with
       `0700`, but this does not protect against root, backups, or
       filesystem snapshots.
     - The user can decline; declining aborts login on this machine.
     - In non-interactive sessions (no TTY) the tool refuses to fall
       back silently; it requires the explicit env var
       `COPILLM_ALLOW_PLAINTEXT_CREDENTIALS=1` before writing
       plaintext.
     - Whenever plaintext credentials are in use the tool emits a
       `WARN` log line at startup, on **every** OS.
   - **User-provisioned file** on any OS. If the user has manually
     placed a valid `credentials.json` at the canonical path (e.g.
     pre-provisioning a CI runner, container image, or a personal
     workstation where they prefer file-based config), the tool MUST
     honor it on every supported OS — macOS and Windows included —
     even when the OS keyring is available and even when keyring
     entries also exist. See the precedence rule below.

#### 11.5.2 Canonical config root (`<copillm-home>`)

The canonical config root resolves to, in order:

1. `$COPILLM_HOME` if set.
2. `~/.copillm/` on **all** supported OSes. The tool deliberately uses
   the same dotfile path on macOS, Linux, and Windows (where it is
   interpreted as `%USERPROFILE%\.copillm\`) so users can sync,
   bind-mount, or hand-edit it the same way everywhere.
3. As a secondary read-only lookup, the OS-conventional config dir is
   also consulted if `~/.copillm/` does not exist (macOS:
   `~/Library/Application Support/copillm/`; Windows:
   `%APPDATA%\copillm\`). New files are always written under
   `<copillm-home>` as resolved by steps 1–2.

Layout:

```
~/.copillm/
├── config.yaml          # selected models, preferred port, caller-secret policy
├── resolution.yaml      # model-alias rules (§11.3); user-editable
├── credentials.json     # present only when file-fallback is active; mode 0600
├── models.cache.json    # last-known-good model list (R-Discovery-2)
├── copillm.pid          # single-instance lock (§11.4)
└── logs/
    └── copillm.log      # rotated, redacted (G19)
```

#### 11.5.3 Precedence rule for credentials (applies on every OS)

If `<copillm-home>/credentials.json` exists at startup **and** parses
as a valid v1 schema, the tool MUST, on every supported OS:

1. **Use the GitHub token from that file as the source of truth**,
   even when an OS keyring entry for `copillm` also exists. This makes
   the file authoritative for users who hand-place it (CI pre-
   provisioning, container images, personal preference, recovery) and
   guarantees that "drop a file here" works identically on macOS,
   Windows, and Linux.
2. Treat the same file as the write target for any subsequent updates
   to the **long-lived** GitHub token (e.g. user re-runs `login` and
   GitHub issues a new value, or upstream returns a permanent 401
   forcing re-auth). The new value MUST be written **in place** to the
   same `credentials.json` — never silently rerouted into the OS
   keyring.
3. Never copy the token from `credentials.json` into the OS keyring as
   a side effect. Migration between stores is an explicit
   `copillm credentials migrate` operation.
4. If both backends contain a token and they differ, the file wins;
   log an `INFO` line noting that the keyring entry is being ignored,
   and do not modify the keyring entry.

If the file does not exist, the OS keyring is used as the source of
truth and the write target, per the platform defaults in §11.5.

The on-disk schema is minimal and forward-compatible:

```json
{
  "version": 1,
  "github_token": "gho_...",
  "account_type": "individual",
  "saved_at": "2026-05-10T12:34:56Z"
}
```

The short-lived Copilot bearer is **never** written here, regardless of
backend or OS (G10 is absolute).

### 11.6 Per-Model Context Limits (closes original gap #7)

The tool MUST NOT ship a hardcoded token-limit table. The Copilot
`/models` response includes a `capabilities.limits` object per model, with
fields including `max_prompt_tokens`, `max_output_tokens`, and
`max_context_window_tokens`. These values are the source of truth for the
truncation logic in §5 step 6. They are cached alongside the model list
and refreshed on the same cadence (R-Discovery-1).

For tokenization: use **`o200k_base`** (cl100k successor; covers GPT-4o
family and recent Anthropic-on-Copilot models adequately for budget
estimation) as the default tokenizer; allow per-model override via
`tokenizer` field in the resolution YAML if upstream returns an
incompatible family. Truncation does not need to be exact — it needs to
be conservative (reserve a 5% safety margin below `max_prompt_tokens`).

### 11.7 Conformance & Testing (closes original gap #8)

Three test layers, all runnable in CI without network:

1. **Unit / translation layer.** Golden-file tests: a corpus of paired
   Anthropic-shape and OpenAI-shape request/response fixtures (covering
   text, multi-turn, tool-call round trips, image input, streaming).
   Each fixture asserts byte-stable translation in both directions.
2. **SDK integration layer.** Run the official OpenAI Python SDK
   (pinned `>=1.40,<2`), the official Anthropic Python SDK (pinned
   `>=0.34,<1`), and the OpenAI TypeScript SDK against the proxy, with
   the upstream stubbed by a mitmproxy-style fake that replays canned
   `/chat/completions` SSE captures. Test matrix: streaming on/off,
   tool-call present/absent, image present/absent. SDK-observable
   behavior (final message content, tool-call arguments, `stop_reason`
   / `finish_reason`) must match the corresponding fixture exactly.
3. **Live smoke layer (opt-in).** A `make smoke` target that, given
   real GitHub credentials in the environment, runs a minimum-viable
   chat in both shapes against the live upstream and asserts a 200 +
   non-empty response. Skipped in normal CI.

Acceptance: every requirement in §2 maps to at least one test in
layers 1 or 2. The mapping table lives in `tests/coverage_matrix.md`
and is checked in CI (a missing G-id fails the build).

### 11.8 Health Endpoint Semantics (closes original gap #9)

Path: `GET /healthz` (served on the same loopback listener as the
proxied APIs).

Behavior:

- If the in-memory bearer is present and not within 60s of expiry:
  return `200 {"status":"ok","bearer_ttl_seconds":<n>}` immediately.
  No upstream call is made (avoids amplifying load, avoids rate-limit
  risk per G27 concern).
- If the bearer is absent, expired, or within the 60s margin: attempt
  one in-line refresh against `/copilot_internal/v2/token` with a 3s
  timeout. On success, return `200`. On failure, return `503
  {"status":"unauthenticated"|"upstream_unreachable", "detail": "..."}`.
- If no long-lived credential is configured at all: return `503
  {"status":"not_logged_in"}`.

A `GET /livez` endpoint also exists and returns `200` if the process is
serving — used by supervisors that want a cheap liveness probe distinct
from upstream-reachability.

### 11.9 Legal & Responsibility Disclaimer (closes original gap #10)

The README MUST include, prominently near the top:

> **Experimental / research tool.** This project is an independent,
> reverse-engineered client of GitHub Copilot's private API. It is not
> affiliated with, endorsed by, or supported by GitHub, Microsoft,
> OpenAI, or Anthropic. It is provided **for research and personal
> experimentation only**.
>
> By using this tool you acknowledge that:
> - You are solely responsible for ensuring your use complies with the
>   [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies),
>   the [GitHub Copilot product terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot),
>   and any other applicable terms of service.
> - Excessive automated or scripted activity may trigger GitHub abuse
>   detection and result in suspension of your Copilot or GitHub
>   account. You assume all such risk.
> - The upstream API is private and may change or be revoked without
>   notice. The tool may stop working at any time.
> - The software is provided **"AS IS", without warranty of any kind,
>   express or implied**, including but not limited to warranties of
>   merchantability, fitness for a particular purpose, and
>   non-infringement. In no event shall the authors or contributors be
>   liable for any claim, damages, or other liability arising from use
>   of this software.
>
> If you do not accept these terms, do not install or run this tool.

x
