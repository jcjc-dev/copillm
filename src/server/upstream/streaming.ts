import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "pino";
import {
  openAIToAnthropic,
  ProtocolTranslationError
} from "../../translation/openaiAnthropic.js";
import {
  translateOpenAIStreamToAnthropic,
  type AnthropicStreamPrelude
} from "../../translation/streamingOpenAIToAnthropic.js";
import { isBenignSocketError, safeSendJson } from "../requestLifecycle.js";
import {
  buildUpstreamErrorPayload,
  formatUpstreamErrorMessage,
  readUpstreamError,
  upstreamStatusCategory,
  writeAnthropicSseError
} from "../errors.js";

export function isEventStream(upstream: Response): boolean {
  const contentType = upstream.headers.get("content-type");
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
}

export function isStreamingRequestBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
}

export function beginAnthropicSseResponse(res: ServerResponse, req?: IncomingMessage): void {
  if (res.headersSent) {
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as any).flushHeaders === "function") {
    (res as any).flushHeaders();
  }
  const socket = res.socket ?? req?.socket;
  if (socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }
}

export async function forwardResponse(
  upstream: Response,
  anthroShape: boolean,
  res: ServerResponse,
  diagnostics: {
    requestedModel?: string;
    prelude?: AnthropicStreamPrelude | null;
    logger: Logger;
    requestId: string;
  }
): Promise<void> {
  if (!upstream.ok) {
    const upstreamError = await readUpstreamError(upstream);
    const category = upstreamStatusCategory(upstream.status);
    diagnostics.logger.warn(
      {
        event: "upstream_non_ok",
        request_id: diagnostics.requestId,
        status_code: upstream.status,
        error: category,
        upstream_content_type: upstreamError.contentType,
        upstream_error_code: upstreamError.code,
        upstream_error_type: upstreamError.type,
        upstream_error_message: upstreamError.message,
        upstream_response_bytes: upstreamError.responseBytes
      },
      "upstream request failed"
    );
    const message = formatUpstreamErrorMessage(category, upstreamError);
    const prelude = diagnostics.prelude ?? null;
    if (prelude) {
      writeAnthropicSseError(res, prelude, message);
      return;
    }
    safeSendJson(
      res,
      upstream.status,
      buildUpstreamErrorPayload(category, upstream.status, diagnostics.requestId, upstreamError, anthroShape)
    );
    return;
  }

  if (isEventStream(upstream)) {
    if (anthroShape) {
      if (!upstream.body) {
        if (diagnostics.prelude) {
          writeAnthropicSseError(res, diagnostics.prelude, "invalid_upstream_response");
          return;
        }
        safeSendJson(res, 502, { error: "invalid_upstream_response", detail: "Upstream stream body is missing." });
        return;
      }
      if (!diagnostics.prelude) {
        beginAnthropicSseResponse(res);
      }
      const upstreamReadable = Readable.fromWeb(upstream.body as any);
      await translateOpenAIStreamToAnthropic({
        upstream: upstreamReadable,
        downstream: res,
        fallbackModel: diagnostics.requestedModel,
        preEmittedMessageId: diagnostics.prelude?.messageId
      });
      return;
    }
    await pipeEventStream(upstream, res);
    return;
  }

  if (diagnostics.prelude) {
    writeAnthropicSseError(res, diagnostics.prelude, "invalid_upstream_response");
    return;
  }

  let json: unknown;
  try {
    json = (await upstream.json()) as unknown;
  } catch {
    safeSendJson(res, 502, { error: "invalid_upstream_response" });
    return;
  }
  let payload: unknown = json;
  if (anthroShape) {
    try {
      payload = openAIToAnthropic(json);
    } catch (error) {
      if (error instanceof ProtocolTranslationError) {
        safeSendJson(res, 502, { error: error.code, detail: error.message });
        return;
      }
      throw error;
    }
  }
  safeSendJson(res, 200, payload);
}

async function pipeEventStream(upstream: Response, res: ServerResponse): Promise<void> {
  if (!upstream.body) {
    safeSendJson(res, 502, { error: "invalid_upstream_response", detail: "Upstream stream body is missing." });
    return;
  }

  res.statusCode = upstream.status;
  res.setHeader("Content-Type", "text/event-stream");
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
  const connection = upstream.headers.get("connection");
  if (connection) {
    res.setHeader("Connection", connection);
  } else {
    res.setHeader("Connection", "keep-alive");
  }
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as any).flushHeaders === "function") {
    (res as any).flushHeaders();
  }
  if (res.socket && typeof res.socket.setNoDelay === "function") {
    res.socket.setNoDelay(true);
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body as any), res);
  } catch (error) {
    if (isBenignSocketError(error)) {
      // Client went away mid-stream — normal for SSE consumers (Codex,
      // Claude Code, pi) that cancel pending responses on user input.
      return;
    }
    throw error;
  }
}
