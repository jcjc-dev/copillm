import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { isBenignSocketError } from "../server/requestLifecycle.js";

interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface ActiveBlock {
  anthropicIndex: number;
  kind: "text" | "tool_use";
}

export interface StreamTranslatorOptions {
  upstream: Readable;
  downstream: Writable;
  fallbackModel?: string;
  preEmittedMessageId?: string;
}

const PING_INTERVAL_MS = 1000;

export async function translateOpenAIStreamToAnthropic(options: StreamTranslatorOptions): Promise<void> {
  const { upstream, downstream } = options;
  upstream.setEncoding("utf8");

  let buffer = "";
  let messageStarted = options.preEmittedMessageId !== undefined;
  let messageId: null | string = options.preEmittedMessageId ?? null;
  let modelName = options.fallbackModel ?? "";
  let role = "assistant";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let stopReason: null | string = null;
  const activeBlocks = new Map<string, ActiveBlock>();
  let nextAnthropicIndex = 0;
  let streamErrored = false;
  let pingTimer: NodeJS.Timeout | null = null;
  let downstreamGone = false;

  function isDownstreamAlive(): boolean {
    if (downstreamGone) return false;
    return downstream.writable && !downstream.writableEnded && !downstream.destroyed;
  }

  function markDownstreamGone(): void {
    if (downstreamGone) return;
    downstreamGone = true;
    stopPings();
    // Best-effort: also stop reading upstream so we don't pull a megabyte
    // of SSE we'll never deliver.
    try {
      upstream.destroy();
    } catch {
      // ignore
    }
  }

  downstream.on("close", markDownstreamGone);
  downstream.on("error", markDownstreamGone);

  function startPings(): void {
    if (pingTimer !== null) {
      return;
    }
    pingTimer = setInterval(() => {
      if (!isDownstreamAlive()) {
        stopPings();
        return;
      }
      writeEvent("ping", { type: "ping" });
    }, PING_INTERVAL_MS);
    if (typeof pingTimer.unref === "function") {
      pingTimer.unref();
    }
  }

  function stopPings(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function writeEvent(eventName: string, data: unknown): void {
    if (!isDownstreamAlive()) {
      markDownstreamGone();
      return;
    }
    try {
      downstream.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      if (isBenignSocketError(error)) {
        markDownstreamGone();
        return;
      }
      throw error;
    }
  }

  function emitMessageStart(): void {
    if (messageStarted) {
      return;
    }
    messageStarted = true;
    if (!messageId) {
      messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    }
    writeEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role,
        content: [],
        model: modelName,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheReadTokens,
          output_tokens: 0
        }
      }
    });
  }

  function ensureTextBlock(): number {
    const existing = activeBlocks.get("text");
    if (existing) {
      return existing.anthropicIndex;
    }
    const index = nextAnthropicIndex;
    nextAnthropicIndex += 1;
    writeEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" }
    });
    activeBlocks.set("text", { anthropicIndex: index, kind: "text" });
    return index;
  }

  function ensureToolBlock(toolIndex: number, id: string, name: string): number {
    const key = `tool:${toolIndex}`;
    const existing = activeBlocks.get(key);
    if (existing) {
      return existing.anthropicIndex;
    }
    const textBlock = activeBlocks.get("text");
    if (textBlock) {
      writeEvent("content_block_stop", { type: "content_block_stop", index: textBlock.anthropicIndex });
      activeBlocks.delete("text");
    }
    const index = nextAnthropicIndex;
    nextAnthropicIndex += 1;
    writeEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} }
    });
    activeBlocks.set(key, { anthropicIndex: index, kind: "tool_use" });
    return index;
  }

  function closeAllBlocks(): void {
    const ordered = Array.from(activeBlocks.values()).sort((a, b) => a.anthropicIndex - b.anthropicIndex);
    for (const block of ordered) {
      writeEvent("content_block_stop", { type: "content_block_stop", index: block.anthropicIndex });
    }
    activeBlocks.clear();
  }

  function processChunk(parsed: OpenAIStreamChunk): void {
    if (parsed.id && !messageId) {
      messageId = `msg_${parsed.id}`;
    }
    if (parsed.model && !modelName) {
      modelName = parsed.model;
    }
    if (parsed.usage) {
      if (typeof parsed.usage.prompt_tokens === "number") {
        inputTokens = parsed.usage.prompt_tokens;
      }
      if (typeof parsed.usage.completion_tokens === "number") {
        outputTokens = parsed.usage.completion_tokens;
      }
      const cached = parsed.usage.prompt_tokens_details?.cached_tokens;
      if (typeof cached === "number") {
        cacheReadTokens = cached;
      }
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      return;
    }
    if (choice.delta?.role && typeof choice.delta.role === "string") {
      role = choice.delta.role;
    }

    emitMessageStart();

    const delta = choice.delta;
    if (delta && typeof delta.content === "string" && delta.content.length > 0) {
      const index = ensureTextBlock();
      writeEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: delta.content }
      });
    }

    if (delta && Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const toolIndex = typeof toolCall.index === "number" ? toolCall.index : 0;
        const key = `tool:${toolIndex}`;
        let blockIndex: null | number = null;
        if (!activeBlocks.has(key)) {
          const id = typeof toolCall.id === "string" ? toolCall.id : "";
          const name = typeof toolCall.function?.name === "string" ? toolCall.function.name : "";
          if (id.length === 0 || name.length === 0) {
            continue;
          }
          blockIndex = ensureToolBlock(toolIndex, id, name);
        } else {
          blockIndex = activeBlocks.get(key)!.anthropicIndex;
        }
        const args = toolCall.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: args }
          });
        }
      }
    }

    if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
  }

  function processLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    if (!line.startsWith("data:")) {
      return;
    }
    const payload = line.slice(5).trim();
    if (payload.length === 0) {
      return;
    }
    if (payload === "[DONE]") {
      return;
    }
    let parsed: OpenAIStreamChunk;
    try {
      parsed = JSON.parse(payload) as OpenAIStreamChunk;
    } catch {
      return;
    }
    processChunk(parsed);
  }

  emitMessageStart();
  startPings();

  try {
    for await (const chunk of upstream) {
      if (!isDownstreamAlive()) {
        markDownstreamGone();
        return;
      }
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      buffer += text;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        processLine(rawLine);
      }
    }
    if (buffer.length > 0) {
      processLine(buffer.replace(/\r$/, ""));
      buffer = "";
    }
  } catch (error) {
    stopPings();
    if (!isDownstreamAlive() || isBenignSocketError(error)) {
      // Either we destroyed the upstream because downstream went away, or
      // the upstream rejected with a benign socket error. Either way, no
      // recovery write is possible — just stop.
      markDownstreamGone();
      return;
    }
    streamErrored = true;
    emitMessageStart();
    closeAllBlocks();
    writeEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens }
    });
    writeEvent("error", {
      type: "error",
      error: { type: "api_error", message: error instanceof Error ? error.message : "upstream stream error" }
    });
    writeEvent("message_stop", { type: "message_stop" });
    safeEndDownstream();
    return;
  }

  if (streamErrored) {
    return;
  }

  stopPings();
  if (!isDownstreamAlive()) {
    return;
  }
  emitMessageStart();
  closeAllBlocks();
  writeEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens }
  });
  writeEvent("message_stop", { type: "message_stop" });
  safeEndDownstream();

  function safeEndDownstream(): void {
    if (downstream.writableEnded || downstream.destroyed) return;
    try {
      downstream.end();
    } catch (error) {
      if (!isBenignSocketError(error)) throw error;
    }
  }
}

export interface AnthropicStreamPrelude {
  messageId: string;
}

/**
 * Write the Anthropic `message_start` event (and an initial ping) to the
 * downstream SSE response immediately, before we begin awaiting the upstream
 * Copilot response. This makes Claude Code render the assistant turn frame
 * within milliseconds of the request, instead of waiting the full ~2s of
 * upstream first-token latency before seeing any sign of life.
 *
 * The returned `messageId` MUST be passed to translateOpenAIStreamToAnthropic
 * via `preEmittedMessageId` so it doesn't double-emit `message_start`.
 */
export function writeAnthropicPrelude(downstream: Writable, model: string): AnthropicStreamPrelude {
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const messageStart = {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
    }
  };
  try {
    downstream.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);
    downstream.write(`event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
  } catch (error) {
    if (!isBenignSocketError(error)) throw error;
  }
  return { messageId };
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}
