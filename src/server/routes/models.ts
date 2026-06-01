import type { ServerResponse } from "node:http";
import type { AppConfig } from "../../types/index.js";
import {
  CopilotTokenManager,
  CopilotTokenManagerError
} from "../../auth/copilotToken.js";
import { listModels, listModelsUnion } from "../../models/discovery.js";
import { buildCodexCatalog } from "../codexSchema.js";
import { buildAnthropicModelsResponse } from "../anthropicModelsResponse.js";
import { safeSendJson } from "../requestLifecycle.js";
import type { RequestRoute } from "./shared.js";

export async function handleModels(
  res: ServerResponse,
  routeKind: Extract<RequestRoute["kind"], "models" | "codex_models" | "anthropic_models">,
  config: AppConfig,
  tokenManager: CopilotTokenManager,
  githubToken: string | undefined
): Promise<void> {
  try {
    await tokenManager.ensureToken(false);
    if (!githubToken) {
      safeSendJson(res, 503, { error: "github_token_unavailable" });
      return;
    }
    const result =
      routeKind === "codex_models" || routeKind === "anthropic_models"
        ? await listModelsUnion(config.accountType, githubToken, 3)
        : await listModels(config.accountType, githubToken);
    if (routeKind === "codex_models") {
      safeSendJson(res, 200, buildCodexCatalog(result.models));
      return;
    }
    if (routeKind === "anthropic_models") {
      safeSendJson(res, 200, buildAnthropicModelsResponse(result.models));
      return;
    }
    safeSendJson(res, 200, {
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
      safeSendJson(res, 503, { error: "token_refresh_failed" });
      return;
    }
    throw error;
  }
}
