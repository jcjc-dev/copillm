import type { ServerResponse } from "node:http";
import type { CopilotTokenManager } from "../../auth/copilotToken.js";
import { healthFailure } from "../errors.js";
import { safeSendJson } from "../requestLifecycle.js";

const HEALTH_REFRESH_THRESHOLD_SECONDS = 60;

export function handleLivez(res: ServerResponse): void {
  safeSendJson(res, 200, { status: "ok", uptime_seconds: Math.floor(process.uptime()) });
}

export async function handleHealthz(
  res: ServerResponse,
  tokenManager: CopilotTokenManager
): Promise<void> {
  const ttl = tokenManager.expiresInSeconds();
  if (ttl !== null && ttl > HEALTH_REFRESH_THRESHOLD_SECONDS) {
    safeSendJson(res, 200, {
      status: "ok",
      token_state: "fresh",
      refresh_threshold_seconds: HEALTH_REFRESH_THRESHOLD_SECONDS,
      bearer_ttl_seconds: ttl
    });
    return;
  }
  try {
    await tokenManager.ensureToken({ refreshThresholdSeconds: HEALTH_REFRESH_THRESHOLD_SECONDS });
    const refreshedTtl = tokenManager.expiresInSeconds() ?? 0;
    safeSendJson(res, 200, {
      status: "ok",
      token_state: "refreshed",
      refresh_threshold_seconds: HEALTH_REFRESH_THRESHOLD_SECONDS,
      bearer_ttl_seconds: refreshedTtl
    });
  } catch (error) {
    const failed = healthFailure(error);
    safeSendJson(res, failed.httpStatus, failed.payload);
  }
}
