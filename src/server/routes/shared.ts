import type { IncomingMessage } from "node:http";
import { stripOneMillionAlias } from "../../translation/openaiAnthropic.js";
import { isValidAccountId } from "../../config/accountId.js";
import { JsonRequestParseError, RequestBodyTooLargeError } from "../errors.js";

/**
 * Default cap on a single request body. The daemon buffers the whole body in
 * memory before forwarding, so an unbounded read is an OOM vector even on a
 * loopback-only socket (a runaway agent or a pathological context). 32 MiB is
 * far above any real chat/completions payload while still bounding memory.
 * Override with `COPILLM_MAX_REQUEST_BYTES` (a positive integer count of bytes).
 */
export const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export function maxRequestBytes(): number {
  const raw = process.env.COPILLM_MAX_REQUEST_BYTES;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_MAX_REQUEST_BYTES;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_REQUEST_BYTES;
  }
  return parsed;
}

export async function readJson(req: IncomingMessage, maxBytes: number = maxRequestBytes()): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > maxBytes) {
      // Stop accumulating immediately so an oversized body can't be buffered
      // into memory; throwing ends the async iteration and tears down the read.
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(buffer);
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
  /**
   * The account selected by a leading `/<account>` path segment, or `null` for
   * the default account (the common, unprefixed case). Only the agent-facing
   * proxy + per-account model routes can be prefixed; daemon-global routes
   * (`/livez`, `/healthz`, `/models`, `/_debug`) never are.
   */
  accountId: string | null;
}

// First path segments that belong to real routes and must never be mistaken
// for an account prefix. (Direct matching already wins for these, so this is
// belt-and-suspenders against contrived nested paths.)
const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "livez",
  "healthz",
  "models",
  "v1",
  "codex",
  "anthropic",
  "_debug"
]);

// Only these routes may be addressed with an `/<account>` prefix. The generic
// `/models` discovery route and all health/debug routes stay global.
const PREFIXABLE_KINDS: ReadonlySet<RequestRoute["kind"]> = new Set([
  "codex_models",
  "anthropic_models",
  "codex_responses",
  "openai",
  "anthropic"
]);

function matchRoute(method: string, pathname: string): RequestRoute | null {
  if (method === "GET" && pathname === "/livez") {
    return { kind: "livez", anthroShape: false, accountId: null };
  }
  if (method === "GET" && pathname === "/healthz") {
    return { kind: "healthz", anthroShape: false, accountId: null };
  }
  if (method === "GET" && (pathname === "/models" || pathname === "/v1/models")) {
    return { kind: "models", anthroShape: false, accountId: null };
  }
  if (method === "GET" && pathname === "/codex/v1/models") {
    return { kind: "codex_models", anthroShape: false, accountId: null };
  }
  if (method === "GET" && pathname === "/anthropic/v1/models") {
    return { kind: "anthropic_models", anthroShape: false, accountId: null };
  }
  if (method === "POST" && pathname === "/codex/v1/responses") {
    return { kind: "codex_responses", anthroShape: false, accountId: null };
  }
  if (method === "GET" && pathname === "/_debug") {
    return { kind: "debug", anthroShape: false, accountId: null };
  }
  if (method === "POST" && pathname === "/v1/chat/completions") {
    return { kind: "openai", anthroShape: false, accountId: null };
  }
  if (method === "POST" && (pathname === "/anthropic/v1/messages" || pathname === "/v1/messages")) {
    return { kind: "anthropic", anthroShape: true, accountId: null };
  }
  return null;
}

export function resolveRoute(method: string | undefined, rawUrl: string | undefined): RequestRoute {
  if (!method || !rawUrl) {
    return { kind: "not_found", anthroShape: false, accountId: null };
  }
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  } catch {
    return { kind: "not_found", anthroShape: false, accountId: null };
  }

  // Try the path as-is first. This keeps every existing (unprefixed) route
  // working unchanged and ensures a reserved first segment like `/codex/...`
  // is always interpreted as a route, never as an account named "codex".
  const direct = matchRoute(method, pathname);
  if (direct) {
    return direct;
  }

  // Otherwise, peel an optional leading `/<account>` segment and re-match the
  // remainder against the prefixable routes.
  const prefixMatch = pathname.match(/^\/([^/]+)(\/.*)$/);
  if (prefixMatch) {
    const candidate = prefixMatch[1];
    const rest = prefixMatch[2];
    if (isValidAccountId(candidate) && !RESERVED_FIRST_SEGMENTS.has(candidate)) {
      const sub = matchRoute(method, rest);
      if (sub && PREFIXABLE_KINDS.has(sub.kind)) {
        return { ...sub, accountId: candidate };
      }
    }
  }

  return { kind: "not_found", anthroShape: false, accountId: null };
}
