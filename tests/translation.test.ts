import { describe, expect, it } from "vitest";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  ProtocolTranslationError,
  stripOneMillionAlias
} from "../src/translation/openaiAnthropic.js";

describe("translation", () => {
  it("maps anthropic request to openai request with tools", () => {
    const request = anthropicToOpenAI({
      model: "claude-3-5-sonnet",
      system: "be concise",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tool" },
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "hello" } }
          ]
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] }]
        }
      ],
      tools: [{ name: "lookup", description: "lookup", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any" }
    });

    expect(request).toMatchObject({
      model: "claude-3-5-sonnet",
      messages: [
        { role: "system", content: "be concise" },
        {
          role: "assistant",
          content: "calling tool",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: { name: "lookup", arguments: "{\"q\":\"hello\"}" }
            }
          ]
        },
        { role: "tool", tool_call_id: "toolu_1", content: "ok" }
      ],
      tool_choice: "required"
    });
  });

  it("preserves stream flag through anthropic-to-openai translation", () => {
    const request = anthropicToOpenAI({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    });
    expect(request).toMatchObject({ stream: true });
  });

  it("translates anthropic tool_result with is_error=true and prefixes the content", () => {
    const request = anthropicToOpenAI({
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "boom", is_error: true }]
        }
      ]
    });
    expect(request).toMatchObject({
      messages: [
        { role: "tool", tool_call_id: "toolu_1", content: "[tool_error] boom" }
      ]
    });
  });

  it("does not prefix tool_result content when is_error is absent or false", () => {
    const request = anthropicToOpenAI({
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok", is_error: false }]
        }
      ]
    });
    expect(request).toMatchObject({
      messages: [
        { role: "tool", tool_call_id: "toolu_2", content: "ok" }
      ]
    });
  });

  it("maps openai response to anthropic message with tool use and stable id", () => {
    const mapped = openAIToAnthropic({
      id: "chatcmpl-abc",
      model: "gpt-4o",
      usage: { prompt_tokens: 10, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 3 } },
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "done",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"q\":\"hello\"}"
                }
              }
            ]
          }
        }
      ]
    });

    expect(mapped).toMatchObject({
      id: "msg_chatcmpl-abc",
      type: "message",
      role: "assistant",
      model: "gpt-4o",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3 },
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "call_1", name: "lookup", input: { q: "hello" } }
      ]
    });
  });

  it("rejects openai responses with unsupported multiple choices", () => {
    expect(() =>
      openAIToAnthropic({
        id: "abc",
        choices: [
          { finish_reason: "stop", message: { content: "one" } },
          { finish_reason: "stop", message: { content: "two" } }
        ]
      })
    ).toThrowError(ProtocolTranslationError);
  });

  it("rejects openai tool calls with invalid JSON arguments", () => {
    expect(() =>
      openAIToAnthropic({
        id: "abc",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{not-json}" }
                }
              ]
            }
          }
        ]
      })
    ).toThrowError(ProtocolTranslationError);
  });

  it("rejects openai content arrays with non-text parts", () => {
    expect(() =>
      openAIToAnthropic({
        id: "abc",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }]
            }
          }
        ]
      })
    ).toThrowError(ProtocolTranslationError);
  });

  it("derives deterministic anthropic ids when openai id is missing", () => {
    const body = {
      model: "gpt-4o",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "same" } }]
    };
    const first = openAIToAnthropic(body);
    const second = openAIToAnthropic(body);
    expect(first).toMatchObject({ id: second.id });
  });

  it("strips a trailing [1m] alias from the request model before forwarding upstream", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-opus-mega[1m]",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(request).toMatchObject({ model: "claude-test-opus-mega" });
  });

  it("leaves a request model without [1m] alias unchanged", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-opus",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(request).toMatchObject({ model: "claude-test-opus" });
  });

  it("rejects a request model that is just the [1m] alias suffix (empty canonical id)", () => {
    expect(() =>
      anthropicToOpenAI({
        model: "[1m]",
        messages: [{ role: "user", content: "hi" }]
      })
    ).toThrowError(ProtocolTranslationError);
  });

  it("stripOneMillionAlias is a no-op for ids without the suffix", () => {
    expect(stripOneMillionAlias("claude-test-opus")).toBe("claude-test-opus");
    expect(stripOneMillionAlias("")).toBe("");
  });
});
