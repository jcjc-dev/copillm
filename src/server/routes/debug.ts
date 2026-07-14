import type { ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "../../types/index.js";
import type { CopilotTokenManager } from "../../auth/copilotToken.js";
import { getGithubUserSummary, GithubUserFetchError } from "../debugInfo.js";
import { safeSendJson } from "../requestLifecycle.js";

const DAEMON_STARTED_AT_ISO = new Date().toISOString();

export async function handleDebug(
  res: ServerResponse,
  input: {
    config: AppConfig;
    logger: Logger;
    tokenManager: CopilotTokenManager;
    githubToken?: string;
    port: number;
    accounts?: { defaultAccountId: string | null; activeAccountIds: string[] };
    packageVersion?: string;
  }
): Promise<void> {
  const bearerTtlSeconds = input.tokenManager.expiresInSeconds();
  const uptimeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(DAEMON_STARTED_AT_ISO)) / 1_000));
  let user: Record<string, unknown> | null = null;
  let userError: string | null = null;

  if (input.githubToken) {
    try {
      // Bound the GitHub user lookup so a slow `api.github.com` cannot hang
      // the `/_debug` handler indefinitely. Matches the bound used by the
      // CLI's `auth status` path (`githubIdentity.ts:42-44`).
      const summary = await getGithubUserSummary(input.githubToken, { timeoutMs: 4_000 });
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

  safeSendJson(res, 200, {
    server: {
      port: input.port,
      pid: process.pid,
      node_version: process.version,
      version: input.packageVersion ?? null,
      started_at_iso: DAEMON_STARTED_AT_ISO,
      uptime_seconds: uptimeSeconds,
      account_type: input.tokenManager.effectiveAccountType(input.config.accountType),
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
    accounts: {
      // Token is never included. Reports the default account id (null for a
      // single-account install) and the named accounts that have served at
      // least one request this daemon lifetime.
      default: input.accounts?.defaultAccountId ?? null,
      active: input.accounts?.activeAccountIds ?? []
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
