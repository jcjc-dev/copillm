import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "pino";
import type { AppConfig } from "../types/index.js";
import { accountBaseUrl, listModels, listModelsUnion, resolveModelId } from "../models/discovery.js";
import {
  CopilotTokenExchangeError,
  CopilotTokenManager,
  CopilotTokenManagerError
} from "../auth/copilotToken.js";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  ProtocolTranslationError,
  stripOneMillionAlias
} from "../translation/openaiAnthropic.js";
import { translateOpenAIStreamToAnthropic, writeAnthropicPrelude, type AnthropicStreamPrelude } from "../translation/streamingOpenAIToAnthropic.js";
import { buildCodexCatalog } from "./codexSchema.js";
import { getGithubUserSummary, GithubUserFetchError } from "./debugInfo.js";
import { buildAnthropicModelsResponse } from "./anthropicModelsResponse.js";
import {
  attachRequestLifecycle,
  isBenignSocketError,
  safeEnd,
  safeSendJson,
  safeWrite
} from "./requestLifecycle.js";

const COPILOT_HEADERS = {
  "Content-Type": "application/json",
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.95.0",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Openai-Intent": "conversation-panel",
  "X-GitHub-Api-Version": "2025-04-01",
  "X-VScode-User-Agent-Library-Version": "electron-fetch",
  // Disable gzip/br on the upstream response. Compressed SSE streams get
  // buffered at gzip flush boundaries by undici's decoder, which causes
  // visible "freeze then dump a paragraph" behaviour in Claude Code and
  // other Anthropic-shape clients. Identity encoding lets each SSE event
  // flow through immediately.
  "Accept-Encoding": "identity"
};
const HEALTH_REFRESH_THRESHOLD_SECONDS = 60;
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_UPSTREAM_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;

interface RequestRoute {
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

const DAEMON_STARTED_AT_ISO = new Date().toISOString();

class JsonRequestParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "JsonRequestParseError";
  }
}

class InvalidRequestShapeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidRequestShapeError";
  }
}

export async function startProxyServer(input: {
  port: number;
  config: AppConfig;
  logger: Logger;
  tokenManager: CopilotTokenManager;
  callerSecret: null | string;
  debug?: boolean;
  githubToken?: string;
}): Promise<{ close: () => Promise<void> }> {
  const debugEnabled = input.debug === true;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const pathname = safePathname(req.url);
    const lifecycle = attachRequestLifecycle(req, res, input.logger, requestId);
    res.on("finish", () => {
      input.logger.info(
        {
          event: "http_request",
          request_id: requestId,
          method: req.method ?? "UNKNOWN",
          path: pathname,
          status_code: res.statusCode,
          duration_ms: Date.now() - startedAt
        },
        "request completed"
      );
    });
    try {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: "non_loopback_request_rejected" });
        return;
      }
      const route = resolveRoute(req.method, req.url);
      if (input.config.requireCallerSecret && route.kind !== "livez" && route.kind !== "healthz") {
        const auth = req.headers.authorization;
        if (!input.callerSecret || auth !== `Bearer ${input.callerSecret}`) {
          sendJson(res, 401, { error: "invalid_caller_secret" });
          return;
        }
      }

      if (route.kind === "livez") {
        sendJson(res, 200, { status: "ok", uptime_seconds: Math.floor(process.uptime()) });
        return;
      }

      if (route.kind === "healthz") {
        const ttl = input.tokenManager.expiresInSeconds();
        if (ttl !== null && ttl > HEALTH_REFRESH_THRESHOLD_SECONDS) {
          sendJson(res, 200, {
            status: "ok",
            token_state: "fresh",
            refresh_threshold_seconds: HEALTH_REFRESH_THRESHOLD_SECONDS,
            bearer_ttl_seconds: ttl
          });
          return;
        }
        try {
          await input.tokenManager.ensureToken({ refreshThresholdSeconds: HEALTH_REFRESH_THRESHOLD_SECONDS });
          const refreshedTtl = input.tokenManager.expiresInSeconds() ?? 0;
          sendJson(res, 200, {
            status: "ok",
            token_state: "refreshed",
            refresh_threshold_seconds: HEALTH_REFRESH_THRESHOLD_SECONDS,
            bearer_ttl_seconds: refreshedTtl
          });
        } catch (error) {
          const failed = healthFailure(error);
          sendJson(res, failed.httpStatus, failed.payload);
        }
        return;
      }

      if (route.kind === "models" || route.kind === "codex_models" || route.kind === "anthropic_models") {
        try {
          await input.tokenManager.ensureToken(false);
          const githubToken = input.githubToken;
          if (!githubToken) {
            sendJson(res, 503, { error: "github_token_unavailable" });
            return;
          }
          const result =
            route.kind === "codex_models" || route.kind === "anthropic_models"
              ? await listModelsUnion(input.config.accountType, githubToken, 3)
              : await listModels(input.config.accountType, githubToken);
          if (route.kind === "codex_models") {
            sendJson(res, 200, buildCodexCatalog(result.models));
            return;
          }
          if (route.kind === "anthropic_models") {
            sendJson(res, 200, buildAnthropicModelsResponse(result.models));
            return;
          }
          sendJson(res, 200, {
            models: result.models,
            discovery: {
              source: result.source,
              stale: result.stale,
              cache_age_seconds: result.cacheAgeSeconds,
              warning: result.warning
            }
          });
        } catch (error) {
          if (error instanceof CopilotTokenManagerError) {
            sendJson(res, 503, { error: "token_refresh_failed" });
            return;
          }
          throw error;
        }
        return;
      }

      if (route.kind === "debug") {
        if (!debugEnabled) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        await handleDebug(res, {
          config: input.config,
          logger: input.logger,
          tokenManager: input.tokenManager,
          githubToken: input.githubToken,
          port: input.port
        });
        return;
      }

      if (route.kind === "not_found") {
        sendJson(res, 404, { error: "not_found" });
        return;
      }

      const requestBody = await readJson(req);
      const translatedBody = translateRequestBody(route.kind, requestBody);
      const requestedModel = readRequestedModel(translatedBody);
      if (input.config.selectedModels.length > 0 && !requestedModel) {
        sendJson(res, 400, {
          error: "model_not_selected",
          detail: "Requested model is not enabled in local selection."
        });
        return;
      }
      let resolvedModel: null | { id: string; rule: string } = null;
      try {
        resolvedModel = requestedModel ? resolveModelId(requestedModel, input.config.selectedModels) : null;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Model resolution failed.";
        sendJson(res, 400, { error: "ambiguous_model_selection", detail });
        return;
      }
      if (input.config.selectedModels.length > 0 && !resolvedModel) {
        sendJson(res, 400, {
          error: "model_not_selected",
          detail: "Requested model is not enabled in local selection."
        });
        return;
      }
      const upstreamBody = resolvedModel ? rewriteRequestedModel(translatedBody, resolvedModel.id) : translatedBody;
      const upstreamPath = route.kind === "codex_responses" ? "/responses" : "/chat/completions";
      const isAnthropicStreaming =
        route.anthroShape && isStreamingRequestBody(translatedBody);
      let prelude: AnthropicStreamPrelude | null = null;
      if (isAnthropicStreaming) {
        beginAnthropicSseResponse(res, req);
        prelude = writeAnthropicPrelude(res, requestedModel ?? "");
      }
      input.logger.debug(
        {
          event: "request_prepared",
          request_id: requestId,
          route: route.kind,
          anthro_shape: route.anthroShape,
          requested_model: requestedModel,
          upstream_model: readRequestedModel(upstreamBody),
          model_resolution_rule: resolvedModel?.rule ?? null,
          upstream_path: upstreamPath,
          ...summarizeUpstreamPayload(upstreamBody)
        },
        "prepared upstream request"
      );
      try {
        const upstream = await postToCopilot({
          tokenManager: input.tokenManager,
          accountType: input.config.accountType,
          body: upstreamBody,
          requestId,
          logger: input.logger,
          upstreamPath,
          signal: lifecycle.signal
        });
        await forwardResponse(upstream, route.anthroShape, res, {
          requestedModel: requestedModel ?? undefined,
          prelude,
          logger: input.logger,
          requestId
        });
      } catch (error) {
        if (isBenignSocketError(error)) {
          input.logger.debug(
            { event: "upstream_aborted", request_id: requestId, err: error },
            "upstream request aborted (client disconnected)"
          );
          safeEnd(res);
          return;
        }
        if (error instanceof CopilotTokenManagerError) {
          if (prelude) {
            writeAnthropicSseError(res, prelude, "token_refresh_failed");
            return;
          }
          sendJson(res, 503, { error: "token_refresh_failed" });
          return;
        }
        if (prelude) {
          writeAnthropicSseError(res, prelude, "internal_error");
          return;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof JsonRequestParseError) {
        sendJson(res, 400, { error: "invalid_request_json", detail: error.message });
        return;
      }
      if (error instanceof InvalidRequestShapeError) {
        sendJson(res, 400, { error: "invalid_request_shape", detail: error.message });
        return;
      }
      if (error instanceof ProtocolTranslationError) {
        sendJson(res, 400, { error: error.code, detail: error.message });
        return;
      }
      if (isBenignSocketError(error)) {
        input.logger.debug(
          { event: "request_client_gone", request_id: requestId, err: error },
          "request handler aborted because client disconnected"
        );
        safeEnd(res);
        return;
      }
      input.logger.error({ err: error, request_id: requestId }, "request failed");
      sendJson(res, 500, { error: "internal_error" });
      safeEnd(res);
    }
  });

  server.on("clientError", (err, socket) => {
    input.logger.debug(
      { event: "client_error", code: (err as { code?: unknown } | null)?.code },
      "malformed HTTP from client"
    );
    if (socket.writable) {
      try {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      } catch {
        // Socket likely already gone — nothing to do.
      }
    }
    try {
      socket.destroy();
    } catch {
      // best effort
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(input.port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  return {
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

async function postToCopilot(input: {
  tokenManager: CopilotTokenManager;
  accountType: AppConfig["accountType"];
  body: unknown;
  requestId: string;
  logger: Logger;
  upstreamPath: string;
  signal?: AbortSignal;
}): Promise<Response> {
  let forceRefresh = false;
  let authRefreshRetried = false;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    if (input.signal?.aborted) {
      throw abortErrorFromSignal(input.signal);
    }
    try {
      const attemptStartedAt = Date.now();
      input.logger.debug(
        {
          event: "upstream_request",
          request_id: input.requestId,
          attempt,
          upstream_path: input.upstreamPath,
          force_refresh: forceRefresh
        },
        "posting upstream request"
      );
      const response = await postWithCurrentBearer(
        input.tokenManager,
        input.accountType,
        input.body,
        forceRefresh,
        input.requestId,
        input.upstreamPath,
        input.signal
      );
      input.logger.debug(
        {
          event: "upstream_response",
          request_id: input.requestId,
          attempt,
          upstream_path: input.upstreamPath,
          status_code: response.status,
          duration_ms: Date.now() - attemptStartedAt,
          content_type: response.headers.get("content-type"),
          retry_after: response.headers.get("retry-after")
        },
        "received upstream response"
      );
      forceRefresh = false;

      if (response.status === 401 && !authRefreshRetried && attempt < MAX_UPSTREAM_ATTEMPTS) {
        authRefreshRetried = true;
        forceRefresh = true;
        input.logger.warn(
          { event: "upstream_retry", request_id: input.requestId, attempt, reason: "upstream_auth_401" },
          "retrying upstream request after forced token refresh"
        );
        await discardUpstreamBody(response);
        continue;
      }

      if (isRetryableStatus(response.status) && attempt < MAX_UPSTREAM_ATTEMPTS) {
        input.logger.warn(
          { event: "upstream_retry", request_id: input.requestId, attempt, status_code: response.status },
          "retrying upstream request"
        );
        await discardUpstreamBody(response);
        await sleep(retryDelayMs(attempt));
        continue;
      }

      return response;
    } catch (error) {
      if (isBenignSocketError(error)) {
        // Client disconnected — propagate so the request handler can clean up.
        throw error;
      }
      if (!isRetryableTransportError(error) || attempt >= MAX_UPSTREAM_ATTEMPTS) {
        throw error;
      }
      input.logger.warn(
        { event: "upstream_retry", request_id: input.requestId, attempt, reason: "transport_error" },
        "retrying upstream request after transport error"
      );
      await sleep(retryDelayMs(attempt));
    }
  }
  throw new Error("Upstream retry budget exhausted unexpectedly.");
}

async function postWithCurrentBearer(
  tokenManager: CopilotTokenManager,
  accountType: AppConfig["accountType"],
  body: unknown,
  forceRefresh: boolean,
  requestId: string,
  upstreamPath: string,
  signal?: AbortSignal
): Promise<Response> {
  const bearer = await tokenManager.ensureToken({ forceRefresh });
  return fetch(`${accountBaseUrl(accountType)}${upstreamPath}`, {
    method: "POST",
    headers: {
      ...COPILOT_HEADERS,
      Authorization: `Bearer ${bearer}`,
      "X-Request-Id": requestId
    },
    body: JSON.stringify(body),
    signal
  });
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error("Request aborted by client");
  (err as { name: string }).name = "AbortError";
  return err;
}

async function forwardResponse(
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
    sendJson(
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
        sendJson(res, 502, { error: "invalid_upstream_response", detail: "Upstream stream body is missing." });
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
    sendJson(res, 502, { error: "invalid_upstream_response" });
    return;
  }
  let payload: unknown = json;
  if (anthroShape) {
    try {
      payload = openAIToAnthropic(json);
    } catch (error) {
      if (error instanceof ProtocolTranslationError) {
        sendJson(res, 502, { error: error.code, detail: error.message });
        return;
      }
      throw error;
    }
  }
  sendJson(res, 200, payload);
}

async function pipeEventStream(upstream: Response, res: ServerResponse): Promise<void> {
  if (!upstream.body) {
    sendJson(res, 502, { error: "invalid_upstream_response", detail: "Upstream stream body is missing." });
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

function isEventStream(upstream: Response): boolean {
  const contentType = upstream.headers.get("content-type");
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
}

function isStreamingRequestBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
}

function beginAnthropicSseResponse(res: ServerResponse, req?: IncomingMessage): void {
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

function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  const local = req.socket.localAddress ?? "";
  return isLoopbackAddress(remote) && (local.length === 0 || isLoopbackAddress(local));
}

function isLoopbackAddress(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  safeSendJson(res, status, payload);
}

function readRequestedModel(payload: unknown): null | string {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const maybeModel = (payload as { model?: unknown }).model;
  return typeof maybeModel === "string" ? maybeModel : null;
}

function rewriteRequestedModel(payload: unknown, model: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...(payload as Record<string, unknown>),
    model
  };
}

function translateRequestBody(routeKind: RequestRoute["kind"], body: unknown): unknown {
  if (routeKind !== "anthropic") {
    return normaliseAliasedModelInPlace(body);
  }
  try {
    return anthropicToOpenAI(body);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidRequestShapeError(error.message);
    }
    throw new InvalidRequestShapeError("Invalid Anthropic request body.");
  }
}

/**
 * Defensive strip of the `[1m]` alias for pass-through routes (OpenAI chat
 * completions, Codex responses). The Anthropic route already strips inside
 * `anthropicToOpenAI`; this catches anything that might land on the
 * pass-through paths with a hand-pasted aliased id so upstream Copilot
 * always receives the canonical model id.
 */
function normaliseAliasedModelInPlace(body: unknown): unknown {
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

async function handleDebug(
  res: ServerResponse,
  input: {
    config: AppConfig;
    logger: Logger;
    tokenManager: CopilotTokenManager;
    githubToken?: string;
    port: number;
  }
): Promise<void> {
  const bearerTtlSeconds = input.tokenManager.expiresInSeconds();
  const uptimeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(DAEMON_STARTED_AT_ISO)) / 1_000));
  let user: Record<string, unknown> | null = null;
  let userError: string | null = null;

  if (input.githubToken) {
    try {
      const summary = await getGithubUserSummary(input.githubToken);
      user = {
        login: summary.login,
        id: summary.id,
        type: summary.type
      };
    } catch (error) {
      if (error instanceof GithubUserFetchError) {
        userError = `github_user_lookup_failed_${error.status}`;
      } else {
        userError = error instanceof Error ? error.message : "unknown_error";
      }
    }
  } else {
    userError = "github_token_unavailable_in_proxy";
  }

  sendJson(res, 200, {
    server: {
      port: input.port,
      pid: process.pid,
      node_version: process.version,
      started_at_iso: DAEMON_STARTED_AT_ISO,
      uptime_seconds: uptimeSeconds,
      account_type: input.config.accountType,
      selected_models: input.config.selectedModels,
      require_caller_secret: input.config.requireCallerSecret,
      log_level: input.logger.level,
      log_file: process.env.COPILLM_LOG_FILE ?? null
    },
    auth: {
      bearer_ttl_seconds: bearerTtlSeconds,
      bearer_present: input.tokenManager.current !== null,
      bearer_expires_at_unix: input.tokenManager.current?.expiresAtUnix ?? null
    },
    user,
    user_error: userError,
    routes: [
      "GET /livez",
      "GET /healthz",
      "GET /models",
      "GET /v1/models",
      "GET /codex/v1/models",
      "GET /anthropic/v1/models",
      "POST /codex/v1/responses",
      "POST /v1/chat/completions",
      "POST /v1/messages",
      "POST /anthropic/v1/messages",
      "GET /_debug"
    ],
    debug_enabled: true
  });
}

function resolveRoute(method: string | undefined, rawUrl: string | undefined): RequestRoute {
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

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_UPSTREAM_STATUSES.has(status);
}

function retryDelayMs(attempt: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
}

function isRetryableTransportError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const typedError = error as Error & { code?: string; cause?: { code?: string } };
  const directCode = typedError.code?.toUpperCase();
  const causeCode = typedError.cause?.code?.toUpperCase();
  if (directCode === "ECONNRESET" || directCode === "ECONNREFUSED" || directCode === "ETIMEDOUT") {
    return true;
  }
  if (causeCode === "ECONNRESET" || causeCode === "ECONNREFUSED" || causeCode === "ETIMEDOUT") {
    return true;
  }
  if (!(typedError instanceof Error)) {
    return false;
  }
  const message = typedError.message.toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) {
    return true;
  }
  return message.includes("econnreset") || message.includes("econnrefused") || message.includes("enotfound");
}

function upstreamStatusCategory(status: number): string {
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

interface UpstreamErrorInfo {
  contentType: string | null;
  code: string | null;
  type: string | null;
  message: string | null;
  responseBytes: number | null;
}

async function readUpstreamError(response: Response): Promise<UpstreamErrorInfo> {
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

function buildUpstreamErrorPayload(
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

function formatUpstreamErrorMessage(category: string, upstreamError: UpstreamErrorInfo): string {
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

function summarizeUpstreamPayload(payload: unknown): Record<string, unknown> {
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
    return value.reduce((total, item) => total + sumTextCharacters(item), 0);
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

function healthFailure(error: unknown): { httpStatus: number; payload: Record<string, unknown> } {
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

function safePathname(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "/";
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

async function discardUpstreamBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // ignore body drain failures
  }
}
