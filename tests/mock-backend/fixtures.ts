// Synthetic model fixtures used by the mock Copilot backend in tests.
// These names are deliberately fictional and do not reference any real product
// versions. They exist only to exercise copillm's wire format and routing.
export const FIXTURE_MODELS = [
  {
    id: "claude-test-opus",
    name: "Claude Test Opus",
    vendor: "Anthropic",
    version: "test-1",
    model_picker_enabled: true,
    policy: { state: "enabled", terms: "test-terms" },
    supported_endpoints: ["/v1/messages", "/chat/completions"],
    capabilities: {
      type: "chat",
      tokenizer: "test",
      family: "claude-test",
      limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 },
      supports: { streaming: true, parallel_tool_calls: true, tool_calls: true }
    }
  },
  {
    id: "claude-test-sonnet",
    name: "Claude Test Sonnet",
    vendor: "Anthropic",
    version: "test-1",
    model_picker_enabled: true,
    policy: { state: "enabled", terms: "test-terms" },
    supported_endpoints: ["/v1/messages", "/chat/completions"],
    capabilities: {
      type: "chat",
      tokenizer: "test",
      family: "claude-test",
      limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 },
      supports: { streaming: true, parallel_tool_calls: true, tool_calls: true }
    }
  },
  {
    id: "claude-test-haiku",
    name: "Claude Test Haiku",
    vendor: "Anthropic",
    version: "test-1",
    model_picker_enabled: true,
    policy: { state: "enabled", terms: "test-terms" },
    supported_endpoints: ["/v1/messages", "/chat/completions"],
    capabilities: {
      type: "chat",
      tokenizer: "test",
      family: "claude-test",
      limits: { max_context_window_tokens: 200000, max_output_tokens: 4096 },
      supports: { streaming: true, parallel_tool_calls: true, tool_calls: true }
    }
  },
  {
    id: "gpt-test",
    name: "GPT Test",
    vendor: "OpenAI",
    version: "test-1",
    model_picker_enabled: true,
    policy: { state: "enabled", terms: "test-terms" },
    supported_endpoints: ["/chat/completions", "/responses"],
    capabilities: {
      type: "chat",
      tokenizer: "test",
      family: "gpt-test",
      limits: { max_context_window_tokens: 128000, max_output_tokens: 8192 },
      supports: {
        streaming: true,
        parallel_tool_calls: true,
        tool_calls: true,
        reasoning_effort: ["low", "medium", "high"]
      }
    }
  },
  {
    id: "gpt-test-codex",
    name: "GPT Test Codex",
    vendor: "OpenAI",
    version: "test-1",
    model_picker_enabled: true,
    policy: { state: "enabled", terms: "test-terms" },
    supported_endpoints: ["/responses"],
    capabilities: {
      type: "chat",
      tokenizer: "test",
      family: "gpt-test-codex",
      limits: { max_context_window_tokens: 256000, max_output_tokens: 16384 },
      supports: {
        streaming: true,
        parallel_tool_calls: true,
        tool_calls: true,
        reasoning_effort: ["low", "medium", "high", "xhigh"]
      }
    }
  }
] as const;

export const FIXTURE_GITHUB_TOKEN = "test-github-token-fixture";
export const FIXTURE_COPILOT_BEARER = "test-copilot-bearer-fixture";
export const FIXTURE_BEARER_TTL_SECONDS = 1800;

export function fixtureBearerExpiresAt(now = Date.now()): number {
  return Math.floor(now / 1000) + FIXTURE_BEARER_TTL_SECONDS;
}

export function fixtureUserPayload(): Record<string, unknown> {
  return {
    login: "copillm-test-user",
    id: 1,
    name: "Copillm Test User",
    email: "test@example.invalid",
    type: "User",
    avatar_url: null,
    html_url: null,
    plan: { name: "test" }
  };
}
