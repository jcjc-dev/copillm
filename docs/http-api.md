---
title: HTTP API reference
nav_order: 6
---

# HTTP API reference

The daemon binds to `http://127.0.0.1:4141` by default. All endpoints accept the `Authorization: Bearer copillm-local` header (any value works — the daemon is local-only).

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

## Translation caveats

copillm translates between OpenAI and Anthropic wire formats and Copilot's upstream. Current behavior:

- **OpenAI-to-Anthropic content parts:** text parts only (no image parts yet).
- **`tool_result` errors:** Anthropic `tool_result` blocks with `is_error: true` are translated into the OpenAI `tool` role (which has no `is_error` field) with the content prefixed by `[tool_error] ` so the assistant still sees that the tool failed. This lets coding agents recover from tool failures (e.g. a failed `Bash` invocation or MCP tool error) instead of the whole conversation 400ing.
- **`[1m]` model id suffix:** Ids advertised on `/anthropic/v1/models` may carry a `[1m]` suffix when the upstream model reports `max_context_window_tokens >= 1_000_000`. The suffix is stripped back off before any request is forwarded upstream, so canonical model ids are always what Copilot sees. See [the Claude Code guide](../claude-code/#context-windows-and-the-1m-alias) for why.
