import { setTimeout as defaultSleep } from "node:timers/promises";

import { githubUserUrl } from "../config/upstream.js";
import { isRetryableStatus, isRetryableTransportError, retryDelayMs } from "./upstream/retryPolicy.js";

interface GithubUserSummary {
  login: string;
  id: number;
  name: string | null;
  email: string | null;
  type: string;
  avatar_url: string | null;
  html_url: string | null;
  plan_name: string | null;
}

const CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;

let cached: { fetchedAt: number; summary: GithubUserSummary } | null = null;

interface GetGithubUserOptions {
  timeoutMs?: number;
  /** Test seam — production callers pass nothing. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/**
 * Fetch the GitHub user summary with bounded retries on transient failures.
 *
 * Was: single fetch, single attempt. A transient 502 from `api.github.com/user`
 * caused `auth status` to hide the user's login and `/_debug` to report
 * `user_error: github_user_lookup_failed_502` instead of the user object.
 *
 * Now: retries 5xx/429/408/409/425 + transient transport errors up to
 * `maxAttempts` (default 3) with exponential backoff (200ms / 400ms). Does
 * NOT retry 401/403/404 — those are terminal credential / endpoint signals
 * and retrying just delays the error the caller needs to surface.
 *
 * Cache write only happens on success.
 */
export async function getGithubUserSummary(
  githubToken: string,
  options: GetGithubUserOptions = {}
): Promise<GithubUserSummary> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.summary;
  }

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleepImpl = options.sleepImpl ?? ((ms) => defaultSleep(ms));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(githubUserUrl(), {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "copillm/0.1.0",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: typeof options.timeoutMs === "number" ? AbortSignal.timeout(options.timeoutMs) : undefined
      });
    } catch (error) {
      lastError = error;
      if (isRetryableTransportError(error) && attempt < maxAttempts) {
        await sleepImpl(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }

    if (response.ok) {
      const payload = (await response.json()) as Partial<GithubUserSummary> & {
        plan?: { name?: string };
      };

      const summary: GithubUserSummary = {
        login: typeof payload.login === "string" ? payload.login : "",
        id: typeof payload.id === "number" ? payload.id : 0,
        name: typeof payload.name === "string" ? payload.name : null,
        email: typeof payload.email === "string" ? payload.email : null,
        type: typeof payload.type === "string" ? payload.type : "User",
        avatar_url: typeof payload.avatar_url === "string" ? payload.avatar_url : null,
        html_url: typeof payload.html_url === "string" ? payload.html_url : null,
        plan_name: typeof payload.plan?.name === "string" ? payload.plan.name : null
      };

      cached = { fetchedAt: Date.now(), summary };
      return summary;
    }

    // Non-OK. 401/403/404 are terminal — fast-fail. Other retryable statuses
    // (429, 5xx) drain the body and retry.
    const detail = await response.text();
    const snippet = detail.slice(0, 256);
    lastError = new GithubUserFetchError(response.status, snippet);

    if (isRetryableStatus(response.status) && attempt < maxAttempts) {
      await sleepImpl(retryDelayMs(attempt));
      continue;
    }

    throw lastError;
  }

  // Unreachable: every loop iteration either returns, throws, or continues
  // (and continue is gated on `attempt < maxAttempts`). Defend anyway.
  throw lastError ?? new Error("GitHub user lookup exhausted retries without error context.");
}

export function clearGithubUserCache(): void {
  cached = null;
}

export class GithubUserFetchError extends Error {
  public constructor(
    public readonly status: number,
    public readonly bodySnippet: string
  ) {
    super(`GitHub user lookup failed (${status}).`);
    this.name = "GithubUserFetchError";
  }
}
