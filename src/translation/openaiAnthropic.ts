import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
}

type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

interface AnthropicImageBlock {
  type: "image";
  source: AnthropicImageSource;
}

type AnthropicMessageBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicUserMessage {
  role: "user" | "assistant" | "system";
  content: AnthropicMessageBlock[] | string;
}

interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema?: unknown;
}

type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

interface AnthropicRequest {
  model: string;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicUserMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
}

interface OpenAIChatCompletionMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
}

interface OpenAIChatCompletionChoice {
  finish_reason?: string | null;
  message?: OpenAIChatCompletionMessage;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIResponse {
  id?: string;
  model?: string;
  usage?: OpenAIUsage;
  choices?: OpenAIChatCompletionChoice[];
}

export class ProtocolTranslationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolTranslationError";
    this.code = code;
  }
}

export function anthropicToOpenAI(body: unknown): Record<string, unknown> {
  const request = parseAnthropicRequest(body);

  const messages: Array<Record<string, unknown>> = [];
  const systemText = translateSystemToText(request.system);
  if (systemText !== null) {
    messages.push({ role: "system", content: systemText });
  }

  for (const message of request.messages) {
    messages.push(...translateAnthropicMessage(message));
  }

  const translated: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: request.max_tokens ?? 1024
  };

  if (request.temperature !== undefined) {
    translated.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    translated.top_p = request.top_p;
  }
  if (request.stop_sequences !== undefined) {
    // Anthropic `stop_sequences` (array of strings) maps 1:1 onto OpenAI's
    // `stop` field, which Copilot's chat/completions endpoint accepts.
    translated.stop = request.stop_sequences;
  }
  if (request.stream !== undefined) {
    translated.stream = request.stream;
  }
  if (request.tools && request.tools.length > 0) {
    translated.tools = request.tools.map(translateToolDefinition);
  }
  if (request.tool_choice) {
    translated.tool_choice = translateToolChoice(request.tool_choice);
  }

  return translated;
}

export function openAIToAnthropic(body: unknown): Record<string, unknown> {
  const payload = parseOpenAIResponse(body);

  if (payload.choices.length !== 1) {
    throw new ProtocolTranslationError(
      "unsupported_multiple_choices",
      "OpenAI response has multiple choices; Anthropic response translation requires exactly one choice."
    );
  }

  const [choice] = payload.choices;
  if (!choice.message) {
    throw new ProtocolTranslationError("missing_choice_message", "OpenAI response choice is missing message content.");
  }

  const messageBlocks = translateOpenAIMessageBlocks(choice.message);

  return {
    id: deriveAnthropicMessageId(payload.id, payload),
    type: "message",
    role: "assistant",
    model: payload.model,
    content: messageBlocks,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: payload.usage?.prompt_tokens ?? 0,
      output_tokens: payload.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0
    }
  };
}

/**
 * The `[1m]` suffix copillm appends to advertised model ids in
 * `/anthropic/v1/models` so Claude Code unlocks its 1M-class autocompact
 * budget for >=1M-context models. Upstream Copilot has never heard of the
 * suffix and must always see the canonical id, so we strip it from any
 * incoming request body before validation or translation. See
 * `applyOneMillionAlias()` in `src/server/anthropicModelsResponse.ts`.
 */
export const ONE_M_ALIAS_SUFFIX = "[1m]";

export function stripOneMillionAlias(model: string): string {
  return model.endsWith(ONE_M_ALIAS_SUFFIX)
    ? model.slice(0, model.length - ONE_M_ALIAS_SUFFIX.length)
    : model;
}

function parseAnthropicRequest(body: unknown): AnthropicRequest {
  if (!isObject(body)) {
    throw new ProtocolTranslationError("invalid_request", "Anthropic request body must be an object.");
  }

  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new ProtocolTranslationError("invalid_model", "Anthropic request model must be a non-empty string.");
  }

  const normalisedModel = stripOneMillionAlias(body.model);
  if (normalisedModel.length === 0) {
    throw new ProtocolTranslationError("invalid_model", "Anthropic request model must be a non-empty string.");
  }

  if (!Array.isArray(body.messages)) {
    throw new ProtocolTranslationError("invalid_messages", "Anthropic request messages must be an array.");
  }

  const parsed: AnthropicRequest = {
    model: normalisedModel,
    messages: body.messages as AnthropicUserMessage[]
  };

  if (body.system !== undefined) {
    parsed.system = body.system as AnthropicRequest["system"];
  }
  if (body.max_tokens !== undefined) {
    parsed.max_tokens = body.max_tokens as number;
  }
  if (body.temperature !== undefined) {
    parsed.temperature = body.temperature as number;
  }
  if (body.top_p !== undefined) {
    parsed.top_p = body.top_p as number;
  }
  if (body.stop_sequences !== undefined) {
    parsed.stop_sequences = body.stop_sequences as string[];
  }
  if (body.stream !== undefined) {
    parsed.stream = body.stream as boolean;
  }
  if (body.tools !== undefined) {
    parsed.tools = body.tools as AnthropicToolDefinition[];
  }
  if (body.tool_choice !== undefined) {
    parsed.tool_choice = body.tool_choice as AnthropicToolChoice;
  }

  return parsed;
}

function parseOpenAIResponse(body: unknown): OpenAIResponse & { choices: OpenAIChatCompletionChoice[] } {
  if (!isObject(body)) {
    throw new ProtocolTranslationError("invalid_response", "OpenAI response body must be an object.");
  }

  if (!Array.isArray(body.choices)) {
    throw new ProtocolTranslationError("missing_choices", "OpenAI response choices must be an array.");
  }

  const parsed: OpenAIResponse & { choices: OpenAIChatCompletionChoice[] } = {
    ...body,
    choices: body.choices as OpenAIChatCompletionChoice[]
  };

  return parsed;
}

function translateSystemToText(system: AnthropicRequest["system"]): null | string {
  if (system === undefined) {
    return null;
  }
  if (typeof system === "string") {
    return system;
  }
  if (!Array.isArray(system)) {
    throw new ProtocolTranslationError("invalid_system", "Anthropic system prompt must be a string or text blocks.");
  }

  return joinTextBlocks(system, "Anthropic system prompt");
}

function translateAnthropicMessage(message: AnthropicUserMessage): Array<Record<string, unknown>> {
  if (message.role !== "assistant" && message.role !== "user" && message.role !== "system") {
    throw new ProtocolTranslationError("unsupported_message_role", `Unsupported Anthropic message role: ${String(message.role)}.`);
  }
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }
  if (!Array.isArray(message.content)) {
    throw new ProtocolTranslationError("invalid_message_content", "Anthropic message content must be a string or array.");
  }

  if (message.role === "system") {
    // Claude Code's "mid-conversation system message" feature (a beta it turns on
    // for correctly-recognised current models, e.g. Opus 4.8) places role:"system"
    // entries inside `messages`, not just the top-level `system` field. Anthropic's
    // own API only accepts system at the top level, but copillm translates to
    // OpenAI chat/completions, which supports system-role messages natively — so
    // map it through instead of 400ing. A 400 here surfaces to the user as a hard
    // API error rather than triggering Claude Code's <system-reminder> fallback.
    return [{ role: "system", content: joinTextBlocks(message.content as AnthropicTextBlock[], "Anthropic system message") }];
  }

  return message.role === "assistant"
    ? translateAssistantMessageBlocks(message.content)
    : translateUserMessageBlocks(message.content);
}

function translateAssistantMessageBlocks(blocks: AnthropicMessageBlock[]): Array<Record<string, unknown>> {
  const textSegments: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of blocks) {
    if (!isObject(block) || typeof block.type !== "string") {
      throw new ProtocolTranslationError("invalid_block", "Anthropic assistant message contains an invalid content block.");
    }

    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new ProtocolTranslationError("invalid_text_block", "Anthropic text block must include string text.");
      }
      textSegments.push(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      if (typeof block.id !== "string" || typeof block.name !== "string") {
        throw new ProtocolTranslationError("invalid_tool_use", "Anthropic tool_use block requires id and name.");
      }
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        }
      });
      continue;
    }

    if (block.type === "tool_result") {
      throw new ProtocolTranslationError(
        "invalid_tool_result_role",
        "Anthropic tool_result blocks are only supported in user messages."
      );
    }

    throw new ProtocolTranslationError("unsupported_block", `Unsupported Anthropic assistant block type: ${block.type}.`);
  }

  return [
    {
      role: "assistant",
      content: textSegments.length > 0 ? textSegments.join("\n") : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    }
  ];
}

type OpenAIUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function translateUserMessageBlocks(blocks: AnthropicMessageBlock[]): Array<Record<string, unknown>> {
  const translated: Array<Record<string, unknown>> = [];
  let parts: OpenAIUserContentPart[] = [];

  const flushParts = (): void => {
    if (parts.length > 0) {
      translated.push({ role: "user", content: collapseUserParts(parts) });
      parts = [];
    }
  };

  for (const block of blocks) {
    if (!isObject(block) || typeof block.type !== "string") {
      throw new ProtocolTranslationError("invalid_block", "Anthropic user message contains an invalid content block.");
    }

    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new ProtocolTranslationError("invalid_text_block", "Anthropic text block must include string text.");
      }
      parts.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "image") {
      parts.push({ type: "image_url", image_url: { url: translateImageSource(block.source) } });
      continue;
    }

    if (block.type === "tool_result") {
      if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
        throw new ProtocolTranslationError("invalid_tool_result", "Anthropic tool_result requires non-empty tool_use_id.");
      }
      flushParts();
      const rawContent = translateToolResultContent(block.content);
      const content = block.is_error ? `[tool_error] ${rawContent}` : rawContent;
      translated.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content
      });
      continue;
    }

    if (block.type === "tool_use") {
      throw new ProtocolTranslationError(
        "invalid_tool_use_role",
        "Anthropic tool_use blocks are only supported in assistant messages."
      );
    }

    throw new ProtocolTranslationError("unsupported_block", `Unsupported Anthropic user block type: ${block.type}.`);
  }

  flushParts();

  if (translated.length === 0) {
    translated.push({ role: "user", content: "" });
  }

  return translated;
}

/**
 * Collapse the accumulated content parts into an OpenAI message `content`.
 * Text-only messages stay a plain newline-joined string (the historical shape
 * every text request produced); once an image is present we must emit the
 * OpenAI multi-part content array so the `image_url` parts survive to upstream.
 */
function collapseUserParts(parts: OpenAIUserContentPart[]): string | OpenAIUserContentPart[] {
  const hasImage = parts.some((part) => part.type === "image_url");
  if (!hasImage) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return parts;
}

/**
 * Translate an Anthropic image `source` into an OpenAI `image_url.url`. A
 * base64 source becomes a `data:` URL; a url source passes its URL through.
 * Copilot's chat/completions endpoint accepts both for vision-capable models;
 * sending an image to a non-vision model surfaces as an upstream error, which
 * is the correct place for that signal — translation stays capability-agnostic.
 */
function translateImageSource(source: unknown): string {
  if (!isObject(source) || typeof source.type !== "string") {
    throw new ProtocolTranslationError("invalid_image_source", "Anthropic image block requires a source object with a type.");
  }
  if (source.type === "base64") {
    if (typeof source.media_type !== "string" || source.media_type.length === 0) {
      throw new ProtocolTranslationError("invalid_image_source", "Anthropic base64 image source requires a media_type.");
    }
    if (typeof source.data !== "string" || source.data.length === 0) {
      throw new ProtocolTranslationError("invalid_image_source", "Anthropic base64 image source requires data.");
    }
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === "url") {
    if (typeof source.url !== "string" || source.url.length === 0) {
      throw new ProtocolTranslationError("invalid_image_source", "Anthropic url image source requires a non-empty url.");
    }
    return source.url;
  }
  throw new ProtocolTranslationError("unsupported_image_source", `Unsupported Anthropic image source type: ${String(source.type)}.`);
}

/**
 * Translate Anthropic `tool_result.content` into the string that goes into the
 * OpenAI `tool` message's `content` field.
 *
 * Anthropic permits a `tool_result.content` array to contain `text` blocks
 * *and* `image` blocks (and tolerates unknown future block types), but the
 * OpenAI chat-completions `tool` role only accepts string content. Rather
 * than reject the whole request — which historically surfaced to Claude Code
 * as the cryptic `invalid_request_shape: Anthropic tool_result content only
 * supports text blocks.` 400 whenever a tool (e.g. a screenshot MCP, an image
 * read) returned an image — we degrade gracefully:
 *
 *   - text blocks  → extracted verbatim
 *   - image blocks → a `[image: <media_type_or_url>]` placeholder so the
 *                    model at least sees that the tool returned an image
 *   - other types  → a `[unsupported tool_result content block: type=X]`
 *                    placeholder
 *
 * Full image pass-through (forwarding the image bytes to the model as a
 * follow-up multi-part user message) is a deliberate non-goal for this
 * function — it would change the request structure and the upstream contract
 * for `tool` messages. We can revisit if/when there is a confirmed need.
 *
 * Malformed `text` blocks (missing `.text`) still throw — that is a real
 * client bug, not a content shape we should silently invent text for.
 */
function translateToolResultContent(content: AnthropicToolResultBlock["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    throw new ProtocolTranslationError(
      "invalid_tool_result_content",
      "Anthropic tool_result content must be a string or an array of content blocks."
    );
  }
  return content.map(stringifyToolResultContentBlock).join("\n");
}

function stringifyToolResultContentBlock(block: unknown): string {
  if (!isObject(block) || typeof block.type !== "string") {
    throw new ProtocolTranslationError(
      "invalid_tool_result_content",
      "Anthropic tool_result content blocks must be objects with a string type."
    );
  }
  if (block.type === "text") {
    if (typeof block.text !== "string") {
      throw new ProtocolTranslationError(
        "invalid_text_block",
        "Anthropic text block must include string text."
      );
    }
    return block.text;
  }
  if (block.type === "image") {
    const descriptor = describeImageSource(block.source);
    return descriptor ? `[image: ${descriptor}]` : "[image]";
  }
  return `[unsupported tool_result content block: type=${block.type}]`;
}

function describeImageSource(source: unknown): string | null {
  if (!isObject(source) || typeof source.type !== "string") {
    return null;
  }
  if (source.type === "base64" && typeof source.media_type === "string" && source.media_type.length > 0) {
    return source.media_type;
  }
  if (source.type === "url" && typeof source.url === "string" && source.url.length > 0) {
    return source.url;
  }
  return null;
}

function translateToolDefinition(tool: AnthropicToolDefinition): Record<string, unknown> {
  if (!isObject(tool) || typeof tool.name !== "string" || tool.name.length === 0) {
    throw new ProtocolTranslationError("invalid_tool_definition", "Anthropic tool definitions require a non-empty name.");
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: isObject(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} }
    }
  };
}

function translateToolChoice(toolChoice: AnthropicToolChoice): unknown {
  if (!isObject(toolChoice) || typeof toolChoice.type !== "string") {
    throw new ProtocolTranslationError("invalid_tool_choice", "Anthropic tool_choice must be an object with a type.");
  }

  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      if (typeof toolChoice.name !== "string" || toolChoice.name.length === 0) {
        throw new ProtocolTranslationError("invalid_tool_choice", "Anthropic tool_choice.type=tool requires a name.");
      }
      return {
        type: "function",
        function: {
          name: toolChoice.name
        }
      };
    case "none":
      return "none";
    default:
      throw new ProtocolTranslationError(
        "unsupported_tool_choice",
        `Unsupported Anthropic tool_choice type: ${(toolChoice as { type: string }).type}.`
      );
  }
}

function joinTextBlocks(blocks: AnthropicTextBlock[], contextLabel: string): string {
  return blocks
    .map((block) => {
      if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") {
        throw new ProtocolTranslationError("unsupported_block", `${contextLabel} only supports text blocks.`);
      }
      return block.text;
    })
    .join("\n");
}

function translateOpenAIMessageBlocks(message: OpenAIChatCompletionMessage): Array<Record<string, unknown>> {
  if (message.role !== undefined && message.role !== "assistant") {
    throw new ProtocolTranslationError(
      "unsupported_message_role",
      `OpenAI response message role ${String(message.role)} cannot be translated to Anthropic assistant response.`
    );
  }

  const blocks: Array<Record<string, unknown>> = [];
  blocks.push(...translateOpenAIContentToAnthropicBlocks(message.content));

  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) {
      throw new ProtocolTranslationError("invalid_tool_calls", "OpenAI tool_calls must be an array when present.");
    }

    for (const toolCall of message.tool_calls) {
      if (!isObject(toolCall) || typeof toolCall.id !== "string" || !isObject(toolCall.function)) {
        throw new ProtocolTranslationError("invalid_tool_call", "OpenAI tool_call is missing id/function fields.");
      }
      if (toolCall.type !== "function") {
        throw new ProtocolTranslationError("unsupported_tool_call", "Only OpenAI function tool calls are supported.");
      }
      if (typeof toolCall.function.name !== "string") {
        throw new ProtocolTranslationError("invalid_tool_call", "OpenAI tool_call.function.name must be a string.");
      }
      if (typeof toolCall.function.arguments !== "string") {
        throw new ProtocolTranslationError("invalid_tool_call", "OpenAI tool_call.function.arguments must be a string.");
      }

      blocks.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseToolArguments(toolCall.function.arguments)
      });
    }
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function translateOpenAIContentToAnthropicBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }

  if (content == null) {
    return [];
  }

  if (!Array.isArray(content)) {
    throw new ProtocolTranslationError(
      "unsupported_content_shape",
      "OpenAI message content must be a string, null, or an array of content parts."
    );
  }

  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!isObject(part) || part.type !== "text" || typeof part.text !== "string") {
      throw new ProtocolTranslationError(
        "unsupported_content_part",
        "Only OpenAI text content parts are supported in Anthropic response translation."
      );
    }
    blocks.push({ type: "text", text: part.text });
  }

  return blocks;
}

function parseToolArguments(argumentsRaw: string): unknown {
  try {
    return JSON.parse(argumentsRaw);
  } catch {
    throw new ProtocolTranslationError("invalid_tool_arguments", "OpenAI tool call arguments must be valid JSON.");
  }
}

function mapFinishReason(reason: string | null | undefined): null | string {
  if (reason == null) {
    return null;
  }
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      throw new ProtocolTranslationError("unsupported_finish_reason", `Unsupported OpenAI finish_reason: ${reason}.`);
  }
}

function deriveAnthropicMessageId(openAIId: string | undefined, payload: OpenAIResponse): string {
  const base =
    typeof openAIId === "string" && openAIId.length > 0
      ? openAIId
      : stableHash(JSON.stringify({ model: payload.model ?? "", choices: payload.choices ?? [] }));

  const normalized = base.replace(/[^a-zA-Z0-9_-]/g, "");
  if (normalized.startsWith("msg_")) {
    return normalized;
  }
  return `msg_${normalized || stableHash(base)}`;
}

function stableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 24);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
