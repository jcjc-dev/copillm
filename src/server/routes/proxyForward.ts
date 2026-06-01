import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "../../types/index.js";
import { resolveModelId } from "../../models/discovery.js";
import {
  CopilotTokenManager,
  CopilotTokenManagerError
} from "../../auth/copilotToken.js";
import {
  anthropicToOpenAI
} from "../../translation/openaiAnthropic.js";
import {
  writeAnthropicPrelude,
  type AnthropicStreamPrelude
} from "../../translation/streamingOpenAIToAnthropic.js";
import { isBenignSocketError, safeEnd, safeSendJson } from "../requestLifecycle.js";
import {
  InvalidRequestShapeError,
  writeAnthropicSseError
} from "../errors.js";
import { postToCopilot } from "../upstream/copilotClient.js";
import {
  beginAnthropicSseResponse,
  forwardResponse,
  isStreamingRequestBody
} from "../upstream/streaming.js";
import {
  normaliseAliasedModelInPlace,
  readJson,
  readRequestedModel,
  rewriteRequestedModel,
  summarizeUpstreamPayload,
  type RequestRoute
} from "./shared.js";

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

export async function handleProxyForward(input: {
  req: IncomingMessage;
  res: ServerResponse;
  route: RequestRoute;
  config: AppConfig;
  tokenManager: CopilotTokenManager;
  logger: Logger;
  requestId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { req, res, route, config, tokenManager, logger, requestId, signal } = input;
  const requestBody = await readJson(req);
  const translatedBody = translateRequestBody(route.kind, requestBody);
  const requestedModel = readRequestedModel(translatedBody);
  if (config.selectedModels.length > 0 && !requestedModel) {
    safeSendJson(res, 400, {
      error: "model_not_selected",
      detail: "Requested model is not enabled in local selection."
    });
    return;
  }
  let resolvedModel: null | { id: string; rule: string } = null;
  try {
    resolvedModel = requestedModel ? resolveModelId(requestedModel, config.selectedModels) : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Model resolution failed.";
    safeSendJson(res, 400, { error: "ambiguous_model_selection", detail });
    return;
  }
  if (config.selectedModels.length > 0 && !resolvedModel) {
    safeSendJson(res, 400, {
      error: "model_not_selected",
      detail: "Requested model is not enabled in local selection."
    });
    return;
  }
  const upstreamBody = resolvedModel ? rewriteRequestedModel(translatedBody, resolvedModel.id) : translatedBody;
  const upstreamPath = route.kind === "codex_responses" ? "/responses" : "/chat/completions";
  const isAnthropicStreaming = route.anthroShape && isStreamingRequestBody(translatedBody);
  let prelude: AnthropicStreamPrelude | null = null;
  if (isAnthropicStreaming) {
    beginAnthropicSseResponse(res, req);
    prelude = writeAnthropicPrelude(res, requestedModel ?? "");
  }
  logger.debug(
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
      tokenManager,
      accountType: config.accountType,
      body: upstreamBody,
      requestId,
      logger,
      upstreamPath,
      signal
    });
    await forwardResponse(upstream, route.anthroShape, res, {
      requestedModel: requestedModel ?? undefined,
      prelude,
      logger,
      requestId
    });
  } catch (error) {
    if (isBenignSocketError(error)) {
      logger.debug(
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
      safeSendJson(res, 503, { error: "token_refresh_failed" });
      return;
    }
    if (prelude) {
      writeAnthropicSseError(res, prelude, "internal_error");
      return;
    }
    throw error;
  }
}
