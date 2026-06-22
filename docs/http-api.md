---
title: HTTP API reference
layout: default
nav_order: 7
---

# HTTP API reference

The daemon binds to `http://127.0.0.1:4141` by default and accepts loopback connections only. By default any `Authorization` value works (e.g. `Authorization: Bearer copillm-local`) — the daemon is local-only. If you set `requireCallerSecret: true` in `~/.copillm/config.yaml`, the daemon generates a random secret at startup (printed as `Caller secret: …` and baked into the env blocks copillm emits), and every route except `/healthz` and `/livez` then requires `Authorization: Bearer <that-secret>`.

## Selecting an account

A single daemon serves every account copillm holds (see [`copillm auth`](../commands/auth/)). A request targets a specific account with an optional leading `/<account>` path segment on the base URL:

```text
http://127.0.0.1:4141/anthropic/v1/messages          # the default account
http://127.0.0.1:4141/work/anthropic/v1/messages     # the "work" account
http://127.0.0.1:4141/work/v1/chat/completions        # likewise, OpenAI route
```

- A base URL with **no** `/<account>` prefix resolves to the **default account** (the common case — the one `copillm auth switch` sets).
- The agent launchers add this prefix for you when you pass [`--account`](../commands/claude/); you only need it when wiring requests by hand.
- **Daemon-global routes are never prefixable:** `/livez`, `/healthz`, `/models`, and `/_debug` always refer to the daemon itself, not an account.
- An account id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; anything else is treated as a normal (unprefixed) path, so existing routes like `/codex/...` and `/v1/...` are never mistaken for an account.

## Discovery

| Method | Path | Description |
|---|---|---|
| `GET` | `/models` | Enumerate eligible models + copillm discovery metadata. |
| `GET` | `/v1/models` | OpenAI-style alias for model discovery. |
| `GET` | `/codex/v1/models` | Codex-flavored model list. |
| `GET` | `/anthropic/v1/models` | Anthropic spec; consumed by Claude Code gateway discovery. |

## Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/healthz` | Readiness probe. |
| `GET` | `/livez` | Liveness probe. |

## Inference

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions, streaming or not. |
| `POST` | `/v1/messages` | Anthropic Messages. |
| `POST` | `/anthropic/v1/messages` | Anthropic Messages (alias). |
| `POST` | `/codex/v1/responses` | Codex Responses API. |

## Example: OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:4141/v1",
    api_key="copillm-local",
)

resp = client.chat.completions.create(
    model="gpt-5",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)
```

## Example: Anthropic SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:4141/anthropic",
    api_key="copillm-local",
)

msg = client.messages.create(
    model="claude-sonnet-4.6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "hello"}],
)
print(msg.content[0].text)
```

## Error handling

When an upstream Copilot API call fails, copillm forwards the upstream HTTP status code through to the caller and returns a sanitized error payload — agents see a real error code instead of a generic `502`. Auth tokens, headers, and request bodies are never echoed back in the response.

OpenAI-shaped routes (`/v1/chat/completions`, `/codex/v1/responses`) return:

```json
{
  "error": {
    "type": "upstream_rate_limited",
    "code": "rate_limit_exceeded",
    "message": "rate_limit_exceeded: ...",
    "upstream_status_code": 429,
    "request_id": "..."
  }
}
```

Anthropic-shaped routes (`/v1/messages`, `/anthropic/v1/messages`) return the same fields under `{"type": "error", "error": {...}}`. Streaming Anthropic responses surface the failure via an SSE `error` event.

`type` and `code` come from the upstream body when available; otherwise they fall back to the copillm error category. Categories the daemon emits today:

| Category | Conditions |
|---|---|
| `upstream_auth_error` | Upstream returned `401` or `403`. |
| `upstream_rate_limited` | Upstream returned `429`. |
| `upstream_server_error` | Upstream returned `5xx`. |
| `upstream_request_error` | Upstream returned `4xx` (other than the above). |
| `upstream_error` | Any other non-2xx response. |

Failures *inside* the daemon (rather than upstream) surface as a `5xx` with a `{ "error": "<kind>", "detail": "..." }` shape:

- A malformed or missing upstream stream returns `502` with `"error": "invalid_upstream_response"`.
- An unexpected daemon-side error returns `500` with `"error": "internal_error"`.

If you see either of these in a coding-agent error message, the daemon itself failed — not Copilot upstream. Re-run with `copillm --debug start` to capture the interaction in `~/.copillm/debug.log`.

### Daemon-side request errors

Two errors come from the daemon validating your request, before any upstream call. Both use the `{ "error": "<kind>", "detail": "..." }` shape:

| Status | `error` | Cause |
|---|---|---|
| `404` | `account_not_found` | The request carried an [`/<account>` prefix](#selecting-an-account) for an account that has no stored credential. Run `copillm auth status` to see which accounts exist. |
| `413` | `payload_too_large` | The request body exceeded the size cap. The daemon stops reading and rejects the request before buffering the whole payload. |

The body-size cap defaults to **32 MiB** — far above any real chat/completions payload — and exists so a runaway agent or a pathological context can't exhaust the single process every agent depends on. Override it with the `COPILLM_MAX_REQUEST_BYTES` environment variable (a positive integer count of bytes).

## Translation caveats

copillm translates between OpenAI and Anthropic wire formats and Copilot's upstream. Current behavior:

- **Anthropic-to-OpenAI image input:** Anthropic `image` content blocks in user messages — both `base64` and `url` sources — are forwarded to Copilot as standard image parts, so vision-capable models can read them. Sending an image to a text-only model surfaces as a normal upstream error.
- **Sampling parameters:** `temperature`, `top_p`, and `stop_sequences` on an Anthropic request are forwarded upstream (`stop_sequences` maps to OpenAI `stop`). `top_k` and `metadata` have no upstream equivalent and are dropped.
- **OpenAI-to-Anthropic content parts:** model responses are text and tool-use only (responses never carry image parts).
- **`tool_result` errors:** Anthropic `tool_result` blocks with `is_error: true` are translated into the OpenAI `tool` role (which has no `is_error` field) with the content prefixed by `[tool_error] ` so the assistant still sees that the tool failed. This lets coding agents recover from tool failures (e.g. a failed `Bash` invocation or MCP tool error) instead of the whole conversation 400ing.
- **`[1m]` model id suffix:** Ids advertised on `/anthropic/v1/models` may carry a `[1m]` suffix when the model id contains `opus` **and** the upstream model reports `max_context_window_tokens >= 1_000_000`. The suffix is stripped back off before any request is forwarded upstream, so canonical model ids are always what Copilot sees. See [the Claude Code guide](../claude-code/#context-windows-and-the-1m-alias) for why.
