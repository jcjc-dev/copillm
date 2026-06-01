import type { ServerResponse } from "node:http";
import {
  CopilotTokenExchangeError,
  CopilotTokenManagerError
} from "../auth/copilotToken.js";
import type { AnthropicStreamPrelude } from "../translation/streamingOpenAIToAnthropic.js";
import { safeEnd, safeWrite } from "./requestLifecycle.js";

export class JsonRequestParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "JsonRequestParseError";
  }
}

export class InvalidRequestShapeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidRequestShapeError";
  }
}

export interface UpstreamErrorInfo {
  contentType: string | null;
  code: string | null;
  type: string | null;
  message: string | null;
  responseBytes: number | null;
}

export async function readUpstreamError(response: Response): Promise<UpstreamErrorInfo> {
  const contentType = response.headers.get("content-type");
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { contentType, code: null, type: null, message: null, responseBytes: null };
  }

  const trimmed = text.trim();
  const responseBytes = Buffer.byteLength(text, "utf8");
  if (trimmed.length === 0) {
    return { contentType, code: null, type: null, message: null, responseBytes };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const extracted = extractErrorFields(parsed);
    if (extracted.message || extracted.code || extracted.type) {
      return { contentType, responseBytes, ...extracted };
    }
  } catch {
    // Fall through to a plain-text snippet below.
  }

  return {
    contentType,
    code: null,
    type: null,
    message: truncateForDiagnostics(trimmed),
    responseBytes
  };
}

function extractErrorFields(payload: unknown): { code: string | null; type: string | null; message: string | null } {
  if (!payload || typeof payload !== "object") {
    return { code: null, type: null, message: typeof payload === "string" ? truncateForDiagnostics(payload) : null };
  }

  const record = payload as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === "string") {
    return {
      code: readStringField(record, "code"),
      type: readStringField(record, "type"),
      message: truncateForDiagnostics(nested)
    };
  }
  if (nested && typeof nested === "object") {
    const errorRecord = nested as Record<string, unknown>;
    return {
      code: readStringField(errorRecord, "code") ?? readStringField(record, "code"),
      type: readStringField(errorRecord, "type") ?? readStringField(record, "type"),
      message:
        readTruncatedStringField(errorRecord, "message") ??
        readTruncatedStringField(errorRecord, "detail") ??
        readTruncatedStringField(record, "message") ??
        readTruncatedStringField(record, "detail")
    };
  }

  return {
    code: readStringField(record, "code"),
    type: readStringField(record, "type"),
    message: readTruncatedStringField(record, "message") ?? readTruncatedStringField(record, "detail")
  };
}

export function buildUpstreamErrorPayload(
  category: string,
  statusCode: number,
  requestId: string,
  upstreamError: UpstreamErrorInfo,
  anthroShape: boolean
): Record<string, unknown> {
  const code = upstreamError.code ?? category;
  const type = upstreamError.type ?? category;
  const message = formatUserFacingUpstreamErrorMessage(category, upstreamError);
  if (anthroShape) {
    return {
      type: "error",
      error: {
        type,
        message,
        code,
        upstream_status_code: statusCode,
        request_id: requestId
      }
    };
  }

  return {
    error: {
      type,
      code,
      message,
      upstream_status_code: statusCode,
      request_id: requestId
    }
  };
}

export function formatUpstreamErrorMessage(category: string, upstreamError: UpstreamErrorInfo): string {
  const parts = [upstreamError.code, upstreamError.type, upstreamError.message].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  return parts.length > 0 ? `${category}: ${parts.join(": ")}` : category;
}

function formatUserFacingUpstreamErrorMessage(category: string, upstreamError: UpstreamErrorInfo): string {
  if (upstreamError.code && upstreamError.message) {
    return `${upstreamError.code}: ${upstreamError.message}`;
  }
  if (upstreamError.message) {
    return upstreamError.message;
  }
  return upstreamError.code ?? upstreamError.type ?? category;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readTruncatedStringField(record: Record<string, unknown>, key: string): string | null {
  const value = readStringField(record, key);
  return value ? truncateForDiagnostics(value) : null;
}

function truncateForDiagnostics(value: string): string {
  const maxChars = 500;
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

export function upstreamStatusCategory(status: number): string {
  if (status === 401 || status === 403) {
    return "upstream_auth_error";
  }
  if (status === 429) {
    return "upstream_rate_limited";
  }
  if (status >= 500) {
    return "upstream_server_error";
  }
  if (status >= 400) {
    return "upstream_request_error";
  }
  return "upstream_error";
}

export function healthFailure(error: unknown): { httpStatus: number; payload: Record<string, unknown> } {
  if (error instanceof CopilotTokenExchangeError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return {
        httpStatus: 401,
        payload: {
          status: "unauthenticated",
          error: "github_auth_invalid",
          upstream_status_code: error.statusCode
        }
      };
    }
    return {
      httpStatus: 503,
      payload: {
        status: "upstream_unreachable",
        error: "token_exchange_failed",
        upstream_status_code: error.statusCode
      }
    };
  }
  if (error instanceof CopilotTokenManagerError) {
    return {
      httpStatus: 401,
      payload: {
        status: "unauthenticated",
        error: "token_refresh_failed"
      }
    };
  }
  return {
    httpStatus: 503,
    payload: {
      status: "upstream_unreachable",
      error: "token_refresh_unavailable"
    }
  };
}

export function writeAnthropicSseError(res: ServerResponse, prelude: AnthropicStreamPrelude, code: string): void {
  void prelude;
  try {
    safeWrite(
      res,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }
      })}\n\n`
    );
    safeWrite(
      res,
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: code } })}\n\n`
    );
    safeWrite(res, `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  } finally {
    safeEnd(res);
  }
}
