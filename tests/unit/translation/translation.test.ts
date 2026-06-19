import { describe, expect, it } from "vitest";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  ProtocolTranslationError,
  stripOneMillionAlias
} from "../../../src/translation/openaiAnthropic.js";

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

  it("translates an image block inside tool_result content to a placeholder string", () => {
    // Regression for https://github.com/jcjc-dev/copillm/issues/... — Claude Code
    // ships tool_result.content arrays that include image blocks (e.g. when a
    // tool reads an image file or a screenshot MCP returns one). Anthropic's
    // spec allows that shape; we used to reject the entire request with
    // 400 invalid_request_shape "Anthropic tool_result content only supports
    // text blocks.". We now degrade to a placeholder so the request goes
    // through and the model at least sees that the tool returned an image.
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_img",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }]
            }
          ]
        }
      ]
    });
    expect(request.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_img", content: "[image: image/png]" }
    ]);
  });

  it("joins mixed text and image blocks inside tool_result content", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_mix",
              content: [
                { type: "text", text: "before" },
                { type: "image", source: { type: "url", url: "https://example.test/cat.png" } },
                { type: "text", text: "after" }
              ]
            }
          ]
        }
      ]
    });
    expect(request.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "toolu_mix",
        content: "before\n[image: https://example.test/cat.png]\nafter"
      }
    ]);
  });

  it("uses a bare [image] placeholder when the image source descriptor is missing", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_img2",
              // An unusual but spec-permissible source shape we can't summarise.
              content: [{ type: "image", source: { type: "file", file_id: "file_abc" } } as unknown as { type: "image"; source: { type: "url"; url: string } }]
            }
          ]
        }
      ]
    });
    expect(request.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_img2", content: "[image]" }
    ]);
  });

  it("tolerates unknown tool_result content block types with a placeholder", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_unknown",
              content: [
                { type: "text", text: "log line" },
                // Some hypothetical future block type — must not 400 the request.
                { type: "document_ref", ref: "doc-1" } as unknown as { type: "text"; text: string }
              ]
            }
          ]
        }
      ]
    });
    expect(request.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "toolu_unknown",
        content: "log line\n[unsupported tool_result content block: type=document_ref]"
      }
    ]);
  });

  it("still prefixes is_error when tool_result content contains an image", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_err_img",
              is_error: true,
              content: [
                { type: "text", text: "failed" },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZZ" } }
              ]
            }
          ]
        }
      ]
    });
    expect(request.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "toolu_err_img",
        content: "[tool_error] failed\n[image: image/jpeg]"
      }
    ]);
  });

  it("still rejects malformed text blocks inside tool_result content", () => {
    expect(() =>
      anthropicToOpenAI({
        model: "claude-test-sonnet",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bad",
                content: [{ type: "text" } as unknown as { type: "text"; text: string }]
              }
            ]
          }
        ]
      })
    ).toThrow(
      expect.objectContaining({
        name: "ProtocolTranslationError",
        code: "invalid_text_block"
      })
    );
  });

  it("maps a mid-conversation role:system message to an OpenAI system message (Claude Code mid-conv-system)", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-opus",
      system: "top-level system",
      messages: [
        { role: "user", content: "hello" },
        { role: "system", content: "learned mid-session: be terse" },
        { role: "assistant", content: "ok" }
      ]
    });
    expect(request.messages).toEqual([
      { role: "system", content: "top-level system" },
      { role: "user", content: "hello" },
      { role: "system", content: "learned mid-session: be terse" },
      { role: "assistant", content: "ok" }
    ]);
  });

  it("joins text blocks inside a role:system message", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-opus",
      messages: [
        { role: "system", content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] },
        { role: "user", content: "hi" }
      ]
    });
    expect(request.messages).toEqual([
      { role: "system", content: "line 1\nline 2" },
      { role: "user", content: "hi" }
    ]);
  });

  it("still rejects non-text blocks inside a system prompt (joinTextBlocks regression guard)", () => {
    expect(() =>
      anthropicToOpenAI({
        model: "claude-test-sonnet",
        system: [
          { type: "text", text: "be concise" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } } as unknown as {
            type: "text";
            text: string;
          }
        ],
        messages: [{ role: "user", content: "hi" }]
      })
    ).toThrow(
      expect.objectContaining({
        name: "ProtocolTranslationError",
        code: "unsupported_block"
      })
    );
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

describe("translation: image content blocks", () => {
  it("maps a base64 image block to an OpenAI image_url data URL (multi-part content)", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAABBBB" } }
          ]
        }
      ]
    });

    expect(request).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAABBBB" } }
          ]
        }
      ]
    });
  });

  it("maps a url image source to an OpenAI image_url url", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://example.test/cat.png" } }]
        }
      ]
    });

    expect(request).toMatchObject({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.test/cat.png" } }]
        }
      ]
    });
  });

  it("flushes a user image message before a following tool_result message", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZZ" } },
            { type: "tool_result", tool_use_id: "toolu_9", content: "done" }
          ]
        }
      ]
    });

    expect(request.messages).toEqual([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,ZZZ" } }]
      },
      { role: "tool", tool_call_id: "toolu_9", content: "done" }
    ]);
  });

  it("keeps text-only multi-block content as a joined string (no array regression)", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" }
          ]
        }
      ]
    });

    expect(request.messages).toEqual([{ role: "user", content: "line one\nline two" }]);
  });

  it("rejects a base64 image source missing media_type", () => {
    expect(() =>
      anthropicToOpenAI({
        model: "claude-test-sonnet",
        messages: [
          { role: "user", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] }
        ]
      })
    ).toThrowError(ProtocolTranslationError);
  });

  it("rejects a base64 image source missing data", () => {
    expect(() =>
      anthropicToOpenAI({
        model: "claude-test-sonnet",
        messages: [
          { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }] }
        ]
      })
    ).toThrowError(ProtocolTranslationError);
  });

  it("rejects a url image source missing url", () => {
    expect(() =>
      anthropicToOpenAI({
        model: "claude-test-sonnet",
        messages: [{ role: "user", content: [{ type: "image", source: { type: "url" } }] }]
      })
    ).toThrowError(ProtocolTranslationError);
  });

  it("rejects an unsupported image source type", () => {
    expect(() =>
      anthropicToOpenAI({
        model: "claude-test-sonnet",
        messages: [{ role: "user", content: [{ type: "image", source: { type: "file" } }] }]
      })
    ).toThrowError(ProtocolTranslationError);
  });

  it("rejects an image block with no source object", () => {
    expect(() =>
      anthropicToOpenAI({
        model: "claude-test-sonnet",
        messages: [{ role: "user", content: [{ type: "image" }] }]
      })
    ).toThrowError(ProtocolTranslationError);
  });
});

describe("translation: sampling parameter passthrough", () => {
  it("passes top_p and stop_sequences through to the OpenAI request", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [{ role: "user", content: "hi" }],
      top_p: 0.9,
      stop_sequences: ["STOP", "\n\nHuman:"]
    });

    expect(request).toMatchObject({ top_p: 0.9, stop: ["STOP", "\n\nHuman:"] });
  });

  it("omits top_p and stop when the Anthropic request does not set them", () => {
    const request = anthropicToOpenAI({
      model: "claude-test-sonnet",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(request.top_p).toBeUndefined();
    expect(request.stop).toBeUndefined();
  });
});
