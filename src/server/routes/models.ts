import type { ServerResponse } from "node:http";
import { CopilotTokenManagerError } from "../../auth/copilotToken.js";
import { listModels, listModelsUnion } from "../../models/discovery.js";
import { buildCodexCatalog } from "../codexSchema.js";
import { buildAnthropicModelsResponse } from "../anthropicModelsResponse.js";
import { tokenErrorToHttpResponse } from "../errors.js";
import { safeSendJson } from "../requestLifecycle.js";
import type { ResolvedAccount } from "../accountResolver.js";
import type { RequestRoute } from "./shared.js";

export async function handleModels(
  res: ServerResponse,
  routeKind: Extract<RequestRoute["kind"], "models" | "codex_models" | "anthropic_models">,
  account: ResolvedAccount
): Promise<void> {
  try {
    await account.tokenManager.ensureToken(false);
    if (!account.githubToken) {
      safeSendJson(res, 503, { error: "github_token_unavailable" });
      return;
    }
    const result =
      routeKind === "codex_models" || routeKind === "anthropic_models"
        ? await listModelsUnion(account.accountType, account.githubToken, 3, undefined, account.cacheId)
        : await listModels(account.accountType, account.githubToken, undefined, account.cacheId);
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
      // Discriminate credential failure (401/403 from upstream — terminal)
      // from transient blip (5xx/429 from upstream — retryable by caller).
      // Was: flat `503 token_refresh_failed` for both, which made codex/pi/
      // claude blindly retry on the permanent case.
      const mapped = tokenErrorToHttpResponse(error);
      safeSendJson(res, mapped.httpStatus, mapped.payload);
      return;
    }
    throw error;
  }
}
