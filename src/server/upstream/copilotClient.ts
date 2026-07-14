import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { AppConfig } from "../../types/index.js";
import { accountBaseUrl } from "../../models/discovery.js";
import { CopilotTokenManager } from "../../auth/copilotToken.js";
import { isBenignSocketError } from "../requestLifecycle.js";
import { isRetryableStatus, isRetryableTransportError, retryDelayMs } from "./retryPolicy.js";

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

const MAX_UPSTREAM_ATTEMPTS = 3;

export async function postToCopilot(input: {
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
  const effectiveAccountType = tokenManager.effectiveAccountType(accountType);
  return fetch(`${accountBaseUrl(effectiveAccountType)}${upstreamPath}`, {
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

async function discardUpstreamBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // ignore body drain failures
  }
}
