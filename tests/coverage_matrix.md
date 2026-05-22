# Coverage Matrix (initial)

This is an initial, practical mapping of selected spec goals to currently automated tests.
It focuses on translation and guardrails that are implemented today.

| Goal ID | Requirement (short) | Coverage | Evidence |
| --- | --- | --- | --- |
| G5 | Preserve tool-calling across translation | ✅ unit | `tests/translation.test.ts` → `maps anthropic request...` and `maps openai response...` |
| G29 | OpenAI shape compatibility safeguards | ✅ unit | `tests/translation.test.ts` → multiple-choice rejection, invalid tool arguments rejection |
| G30 | Anthropic shape compatibility safeguards | ✅ unit | `tests/translation.test.ts` → anthropic streaming rejection, tool_result `is_error` translation with `[tool_error]` prefix, `[1m]` alias strip on request model |
| G31 | Stable identifiers in translated responses | ✅ unit | `tests/translation.test.ts` → stable id passthrough + deterministic fallback id |
| G32 | Claude Code 1M context unlock for >=1M-context models | ✅ unit | `tests/anthropicModelsResponse.test.ts` → `[1m]` suffix applied at 1_000_000 boundary, not below; double-suffix safe |

## Known gaps (not yet automated)

- SDK-level compatibility matrix (OpenAI/Anthropic SDK end-to-end).
- Streaming translation coverage for Anthropic response shape.
- Image-content round-trip translation tests.
