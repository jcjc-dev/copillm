import type { IncomingMessage } from "node:http";
import { stripOneMillionAlias } from "../../translation/openaiAnthropic.js";
import { JsonRequestParseError } from "../errors.js";

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new JsonRequestParseError("Failed to parse JSON body.");
    }
    throw error;
  }
}

export function readRequestedModel(payload: unknown): null | string {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const maybeModel = (payload as { model?: unknown }).model;
  return typeof maybeModel === "string" ? maybeModel : null;
}

export function rewriteRequestedModel(payload: unknown, model: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...(payload as Record<string, unknown>),
    model
  };
}

/**
 * Defensive strip of the `[1m]` alias for pass-through routes (OpenAI chat
 * completions, Codex responses). The Anthropic route already strips inside
 * `anthropicToOpenAI`; this catches anything that might land on the
 * pass-through paths with a hand-pasted aliased id so upstream Copilot
 * always receives the canonical model id.
 */
export function normaliseAliasedModelInPlace(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.model === "string") {
      const stripped = stripOneMillionAlias(record.model);
      if (stripped !== record.model) {
        record.model = stripped;
      }
    }
  }
  return body;
}

export function summarizeUpstreamPayload(payload: unknown): Record<string, unknown> {
  let requestBytes: number | null = null;
  try {
    requestBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    requestBytes = null;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { upstream_request_bytes: requestBytes };
  }

  const record = payload as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : null;
  const input = Array.isArray(record.input) ? record.input : null;
  return {
    upstream_request_bytes: requestBytes,
    stream: record.stream === true,
    max_tokens: typeof record.max_tokens === "number" ? record.max_tokens : null,
    message_count: messages?.length ?? null,
    input_item_count: input?.length ?? null,
    tool_count: Array.isArray(record.tools) ? record.tools.length : 0,
    text_characters: sumTextCharacters(payload)
  };
}

function sumTextCharacters(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + sumTextCharacters(item), 0);
  }

  let total = 0;
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (key === "text" || key === "content" || key === "arguments" || key === "input") {
      total += sumTextCharacters(nested);
    } else if (nested && typeof nested === "object" && key !== "data" && key !== "image_url" && key !== "source") {
      total += sumTextCharacters(nested);
    }
  }
  return total;
}

export function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  const local = req.socket.localAddress ?? "";
  return isLoopbackAddress(remote) && (local.length === 0 || isLoopbackAddress(local));
}

function isLoopbackAddress(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

export function safePathname(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "/";
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

export interface RequestRoute {
  kind:
    | "livez"
    | "healthz"
    | "models"
    | "openai"
    | "anthropic"
    | "anthropic_models"
    | "codex_models"
    | "codex_responses"
    | "debug"
    | "not_found";
  anthroShape: boolean;
}

export function resolveRoute(method: string | undefined, rawUrl: string | undefined): RequestRoute {
  if (!method || !rawUrl) {
    return { kind: "not_found", anthroShape: false };
  }
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  } catch {
    return { kind: "not_found", anthroShape: false };
  }
  if (method === "GET" && pathname === "/livez") {
    return { kind: "livez", anthroShape: false };
  }
  if (method === "GET" && pathname === "/healthz") {
    return { kind: "healthz", anthroShape: false };
  }
  if (method === "GET" && (pathname === "/models" || pathname === "/v1/models")) {
    return { kind: "models", anthroShape: false };
  }
  if (method === "GET" && pathname === "/codex/v1/models") {
    return { kind: "codex_models", anthroShape: false };
  }
  if (method === "GET" && pathname === "/anthropic/v1/models") {
    return { kind: "anthropic_models", anthroShape: false };
  }
  if (method === "POST" && pathname === "/codex/v1/responses") {
    return { kind: "codex_responses", anthroShape: false };
  }
  if (method === "GET" && pathname === "/_debug") {
    return { kind: "debug", anthroShape: false };
  }
  if (method === "POST" && pathname === "/v1/chat/completions") {
    return { kind: "openai", anthroShape: false };
  }
  if (method === "POST" && (pathname === "/anthropic/v1/messages" || pathname === "/v1/messages")) {
    return { kind: "anthropic", anthroShape: true };
  }
  return { kind: "not_found", anthroShape: false };
}
