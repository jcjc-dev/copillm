# Coverage Matrix

A practical mapping of selected translation + guardrail behaviours to the tests
that exercise them today. It is not exhaustive — it tracks the contracts most
likely to regress silently.

| Goal ID | Requirement (short) | Coverage | Evidence |
| --- | --- | --- | --- |
| G5 | Preserve tool-calling across translation | ✅ unit | `tests/unit/translation/translation.test.ts` → anthropic request tool mapping + openai response tool_use mapping |
| G29 | OpenAI shape compatibility safeguards | ✅ unit | `tests/unit/translation/translation.test.ts` → multiple-choice rejection, invalid tool-arguments rejection, non-text content-part rejection |
| G30 | Anthropic shape compatibility safeguards | ✅ unit | `tests/unit/translation/translation.test.ts` → tool_result `is_error` `[tool_error]` prefixing, `[1m]` alias strip on request model |
| G31 | Stable identifiers in translated responses | ✅ unit | `tests/unit/translation/translation.test.ts` → stable id passthrough + deterministic fallback id |
| G32 | Claude Code 1M context unlock for >=1M-context models | ✅ unit | `tests/unit/server/anthropicModelsResponse.test.ts` → `[1m]` suffix applied at the 1,000,000 boundary, not below; double-suffix safe |
| G33 | Image/multimodal input on the Anthropic route | ✅ unit + integration | `tests/unit/translation/translation.test.ts` (base64/url image blocks → OpenAI `image_url`, multi-part content, malformed-source rejection); `tests/integration/proxyImageTranslation.test.ts` (translated `image_url` reaches upstream through the proxy) |
| G34 | Sampling-parameter passthrough | ✅ unit | `tests/unit/translation/translation.test.ts` → `top_p` + `stop_sequences`→`stop` forwarded; absent when unset |
| G35 | Streaming Anthropic response shape (SSE translation) | ✅ unit | `tests/unit/translation/streamingTranslation.test.ts` → canonical event order, interleaved text/tool blocks, multiple tool calls, mid-stream error recovery, malformed-line tolerance, usage accounting, keepalive ping |

## Known gaps (not yet automated)

- SDK-level compatibility matrix: end-to-end against the official OpenAI / Anthropic SDKs (the e2e suite drives synthetic clients plus the real Codex and Claude Code CLIs, but not the vendor SDKs directly).
