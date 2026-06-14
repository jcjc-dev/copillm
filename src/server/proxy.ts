import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../types/index.js";
import { CopilotTokenManager } from "../auth/copilotToken.js";
import {
  singleAccountResolver,
  type AccountResolver,
  type ResolvedAccount
} from "./accountResolver.js";
import {
  attachRequestLifecycle,
  isBenignSocketError,
  safeEnd,
  safeSendJson
} from "./requestLifecycle.js";
import {
  InvalidRequestShapeError,
  JsonRequestParseError,
  RequestBodyTooLargeError
} from "./errors.js";
import { ProtocolTranslationError } from "../translation/openaiAnthropic.js";
import { handleHealthz, handleLivez } from "./routes/health.js";
import { handleModels } from "./routes/models.js";
import { handleDebug } from "./routes/debug.js";
import { handleProxyForward } from "./routes/proxyForward.js";
import { isLocalRequest, resolveRoute, safePathname, type RequestRoute } from "./routes/shared.js";

export async function startProxyServer(input: {
  port: number;
  config: AppConfig;
  logger: Logger;
  tokenManager: CopilotTokenManager;
  callerSecret: null | string;
  debug?: boolean;
  githubToken?: string;
  /**
   * Multi-account resolver. When omitted, a single-account resolver wrapping
   * `tokenManager` + `githubToken` is used, preserving the exact pre-multi-
   * account behaviour (every request serves the default account).
   */
  accountResolver?: AccountResolver;
}): Promise<{ close: () => Promise<void> }> {
  const debugEnabled = input.debug === true;
  const resolver: AccountResolver =
    input.accountResolver ??
    singleAccountResolver({
      tokenManager: input.tokenManager,
      githubToken: input.githubToken ?? "",
      accountType: input.config.accountType
    });

  // Resolve the account a request targets. Returns the default account for an
  // unprefixed request; for an `/<account>` prefix, looks up the named account
  // and answers 404 `account_not_found` when no credential is stored for it.
  const resolveAccountForRoute = async (route: RequestRoute): Promise<ResolvedAccount | null> => {
    if (route.accountId === null) {
      return resolver.default;
    }
    const account = await resolver.resolveById(route.accountId);
    return account;
  };

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
        safeSendJson(res, 403, { error: "non_loopback_request_rejected" });
        return;
      }
      const route = resolveRoute(req.method, req.url);
      if (input.config.requireCallerSecret && route.kind !== "livez" && route.kind !== "healthz") {
        const auth = req.headers.authorization;
        if (!input.callerSecret || auth !== `Bearer ${input.callerSecret}`) {
          safeSendJson(res, 401, { error: "invalid_caller_secret" });
          return;
        }
      }

      switch (route.kind) {
        case "livez":
          handleLivez(res);
          return;
        case "healthz":
          await handleHealthz(res, resolver.default.tokenManager);
          return;
        case "models":
          await handleModels(res, route.kind, resolver.default);
          return;
        case "codex_models":
        case "anthropic_models": {
          const account = await resolveAccountForRoute(route);
          if (!account) {
            safeSendJson(res, 404, { error: "account_not_found", detail: `No stored credential for account "${route.accountId}".` });
            return;
          }
          await handleModels(res, route.kind, account);
          return;
        }
        case "debug":
          if (!debugEnabled) {
            safeSendJson(res, 404, { error: "not_found" });
            return;
          }
          await handleDebug(res, {
            config: input.config,
            logger: input.logger,
            tokenManager: resolver.default.tokenManager,
            githubToken: resolver.default.githubToken,
            port: input.port,
            accounts: resolver.describe()
          });
          return;
        case "not_found":
          safeSendJson(res, 404, { error: "not_found" });
          return;
        case "openai":
        case "anthropic":
        case "codex_responses": {
          const account = await resolveAccountForRoute(route);
          if (!account) {
            safeSendJson(res, 404, { error: "account_not_found", detail: `No stored credential for account "${route.accountId}".` });
            return;
          }
          await handleProxyForward({
            req,
            res,
            route,
            config: input.config,
            account,
            logger: input.logger,
            requestId,
            signal: lifecycle.signal
          });
          return;
        }
      }
    } catch (error) {
      if (error instanceof JsonRequestParseError) {
        safeSendJson(res, 400, { error: "invalid_request_json", detail: error.message });
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        safeSendJson(res, 413, { error: "payload_too_large", detail: error.message });
        return;
      }
      if (error instanceof InvalidRequestShapeError) {
        safeSendJson(res, 400, { error: "invalid_request_shape", detail: error.message });
        return;
      }
      if (error instanceof ProtocolTranslationError) {
        safeSendJson(res, 400, { error: error.code, detail: error.message });
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
      safeSendJson(res, 500, { error: "internal_error" });
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

export { writeAnthropicSseError } from "./errors.js";
