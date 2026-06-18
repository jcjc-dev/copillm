import type { ServerResponse } from "node:http";
import type { CopilotTokenManager } from "../../auth/copilotToken.js";
import { healthFailure } from "../errors.js";
import { safeSendJson } from "../requestLifecycle.js";

const HEALTH_REFRESH_THRESHOLD_SECONDS = 60;

export interface HealthMetadata {
  /**
   * The version of the daemon process answering this health probe — sourced
   * from `getPackageInfo()` at proxy startup. Surfaced so `copillm status`
   * can tell users whether the running daemon matches the binary they have
   * on disk ("restart to pick up vX.Y.Z").
   */
  version: string;
}

export function handleLivez(res: ServerResponse, meta: HealthMetadata): void {
  safeSendJson(res, 200, {
    status: "ok",
    uptime_seconds: Math.floor(process.uptime()),
    version: meta.version
  });
}

export async function handleHealthz(
  res: ServerResponse,
  tokenManager: CopilotTokenManager,
  meta: HealthMetadata
): Promise<void> {
  const ttl = tokenManager.expiresInSeconds();
  if (ttl !== null && ttl > HEALTH_REFRESH_THRESHOLD_SECONDS) {
    safeSendJson(res, 200, {
      status: "ok",
      token_state: "fresh",
      refresh_threshold_seconds: HEALTH_REFRESH_THRESHOLD_SECONDS,
      bearer_ttl_seconds: ttl,
      version: meta.version
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
      bearer_ttl_seconds: refreshedTtl,
      version: meta.version
    });
  } catch (error) {
    const failed = healthFailure(error);
    safeSendJson(res, failed.httpStatus, { ...failed.payload, version: meta.version });
  }
}
