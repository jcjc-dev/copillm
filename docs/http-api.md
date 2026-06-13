---
title: HTTP API reference
layout: default
nav_order: 7
---

# HTTP API reference

The daemon binds to `http://127.0.0.1:4141` by default and accepts loopback connections only. By default any `Authorization` value works (e.g. `Authorization: Bearer copillm-local`) — the daemon is local-only. If you set `requireCallerSecret: true` in `~/.copillm/config.yaml`, the daemon generates a random secret at startup (printed as `Caller secret: …` and baked into the env blocks copillm emits), and every route except `/healthz` and `/livez` then requires `Authorization: Bearer <that-secret>`.

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

When an upstream Copilot API call fails, copillm forwards the upstream HTTP status code through to the caller and returns a sanitized error payload — agents see a real error code instead of a generic `502 proxy_error`. Auth tokens, headers, and request bodies are never echoed back in the response.

OpenAI-shaped routes (`/v1/chat/completions`, `/codex/v1/responses`) return:

```json
{
  "error": {
    "type": "upstream_rate_limited",
    "code": "rate_limit_exceeded",
    "message": "upstream_rate_limited: rate_limit_exceeded: ...",
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

Transport-level failures *inside* the daemon (a panic, malformed upstream stream, or a daemon-side bug) still surface as `502` with `{ "error": "<kind>", "detail": "..." }`. If you see `proxy_error` from a coding-agent error message, that is the daemon itself failing, not Copilot upstream.

## Translation caveats

copillm translates between OpenAI and Anthropic wire formats and Copilot's upstream. Current behavior:

- **OpenAI-to-Anthropic content parts:** text parts only (no image parts yet).
- **`tool_result` errors:** Anthropic `tool_result` blocks with `is_error: true` are translated into the OpenAI `tool` role (which has no `is_error` field) with the content prefixed by `[tool_error] ` so the assistant still sees that the tool failed. This lets coding agents recover from tool failures (e.g. a failed `Bash` invocation or MCP tool error) instead of the whole conversation 400ing.
- **`[1m]` model id suffix:** Ids advertised on `/anthropic/v1/models` may carry a `[1m]` suffix when the upstream model reports `max_context_window_tokens >= 1_000_000`. The suffix is stripped back off before any request is forwarded upstream, so canonical model ids are always what Copilot sees. See [the Claude Code guide](../claude-code/#context-windows-and-the-1m-alias) for why.
