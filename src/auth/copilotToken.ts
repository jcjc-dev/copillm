import { setTimeout as defaultSleep } from "node:timers/promises";

import type { AccountType, TokenState } from "../types/index.js";
import { accountTypeFromCopilotApiUrl, tokenExchangeUrl } from "../config/upstream.js";
import { isRetryableStatus, isRetryableTransportError, retryDelayMs } from "../server/upstream/retryPolicy.js";

interface TokenExchangeResponse {
  token: string;
  expires_at: number;
  endpoints?: {
    api?: unknown;
  };
}

interface EnsureTokenOptions {
  forceRefresh?: boolean;
  refreshThresholdSeconds?: number;
}

/**
 * Optional dependency-injection seam for tests. Production callers pass
 * nothing and we use the global `fetch` + `node:timers/promises` sleep.
 * Both must be specified together when overridden so the test author
 * can't accidentally mock one and forget the other.
 */
export interface CopilotTokenManagerDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Per-attempt timeout. Each fetch gets its own `AbortSignal.timeout(...)`
   * so a hung upstream can't pin the request indefinitely. Default 10s —
   * `api.github.com/copilot_internal/v2/token` responds in <500ms on a
   * healthy network, so 10s leaves room for slow networks without hanging
   * `copillm start` for a full minute when GitHub goes dark.
   */
  attemptTimeoutMs?: number;
  /**
   * Max number of exchange attempts before giving up. Default 3.
   * Mirrors `src/server/upstream/copilotClient.ts` so a future shared
   * retry harness stays consistent.
   */
  maxAttempts?: number;
}

const DEFAULT_REFRESH_THRESHOLD_SECONDS = 300;
const MIN_ACCEPTABLE_TTL_SECONDS = 30;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class CopilotTokenManagerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CopilotTokenManagerError";
  }
}

export class CopilotTokenExchangeError extends CopilotTokenManagerError {
  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBodySnippet: string
  ) {
    super(message);
    this.name = "CopilotTokenExchangeError";
  }
}

export class CopilotTokenPayloadError extends CopilotTokenManagerError {
  public constructor(message: string) {
    super(message);
    this.name = "CopilotTokenPayloadError";
  }
}

export class CopilotTokenExpiredError extends CopilotTokenManagerError {
  public constructor(message: string) {
    super(message);
    this.name = "CopilotTokenExpiredError";
  }
}

/**
 * `CopilotTokenExchangeError` is thrown both for "retryable" upstream statuses
 * (after retries are exhausted) and for terminal credential failures (401/403
 * — bad OAuth token, never retried). Tests and error-mapping code can use
 * this helper to keep the classification consistent across surfaces.
 */
export function isTerminalCredentialStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export class CopilotTokenManager {
  private state: null | TokenState = null;
  private refreshInFlight: null | Promise<TokenState> = null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;

  public constructor(private readonly githubToken: string, deps?: CopilotTokenManagerDeps) {
    this.fetchImpl = deps?.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleepImpl = deps?.sleepImpl ?? ((ms) => defaultSleep(ms));
    this.attemptTimeoutMs = deps?.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.maxAttempts = deps?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  public get current(): null | TokenState {
    return this.state;
  }

  public expiresInSeconds(nowUnix = this.nowUnix()): null | number {
    if (!this.state) {
      return null;
    }
    return Math.max(0, this.state.expiresAtUnix - nowUnix);
  }

  public effectiveAccountType(fallback: AccountType): AccountType {
    return this.state?.detectedAccountType ?? fallback;
  }

  public shouldRefresh(options?: { nowUnix?: number; refreshThresholdSeconds?: number }): boolean {
    const threshold = options?.refreshThresholdSeconds ?? DEFAULT_REFRESH_THRESHOLD_SECONDS;
    const expiresIn = this.expiresInSeconds(options?.nowUnix ?? this.nowUnix());
    return expiresIn === null || expiresIn <= threshold;
  }

  public async ensureToken(options?: boolean | EnsureTokenOptions): Promise<string> {
    const normalized = this.normalizeEnsureTokenOptions(options);
    const needsRefresh = normalized.forceRefresh || this.shouldRefresh({ refreshThresholdSeconds: normalized.refreshThresholdSeconds });

    if (!needsRefresh) {
      return this.state!.token;
    }
    const next = await this.refreshToken();
    return next.token;
  }

  public clear(): void {
    this.state = null;
    this.refreshInFlight = null;
  }

  /**
   * Perform the upstream token exchange with bounded retries.
   *
   * Retry policy mirrors `src/server/upstream/copilotClient.ts`:
   *   - 3 attempts max (configurable via constructor deps)
   *   - exponential backoff: 200ms, 400ms (no sleep after final attempt)
   *   - retry on status ∈ {408, 409, 425, 429, 500, 502, 503, 504}
   *   - retry on transient transport errors (ECONNRESET / EAI_AGAIN / ...)
   *   - 401/403/404 are terminal: bad credentials, not a blip — fail fast
   *
   * Each attempt gets its own `AbortSignal.timeout(attemptTimeoutMs)` so a
   * hung upstream can't freeze `copillm start` for the lifetime of the
   * whole process. The previous version had no timeout at all.
   */
  private async exchange(): Promise<TokenState> {
    let lastErrorThrown: unknown;
    let lastStatusError: null | CopilotTokenExchangeError = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(tokenExchangeUrl(), {
          method: "GET",
          headers: {
            Authorization: `token ${this.githubToken}`,
            "User-Agent": "copillm/0.1.0",
            Accept: "application/json"
          },
          signal: AbortSignal.timeout(this.attemptTimeoutMs)
        });
      } catch (error) {
        lastErrorThrown = error;
        if (isRetryableTransportError(error) && attempt < this.maxAttempts) {
          await this.sleepImpl(retryDelayMs(attempt));
          continue;
        }
        throw error;
      }

      if (response.ok) {
        const payload = (await response.json()) as TokenExchangeResponse;
        if (!payload.token || !payload.expires_at || !Number.isFinite(payload.expires_at)) {
          throw new CopilotTokenPayloadError("Token exchange response was missing required fields.");
        }
        const now = this.nowUnix();
        const ttl = payload.expires_at - now;
        if (ttl <= MIN_ACCEPTABLE_TTL_SECONDS) {
          throw new CopilotTokenExpiredError(`Received near-expired Copilot token (ttl_seconds=${Math.max(0, ttl)}).`);
        }
        const detectedAccountType =
          accountTypeFromCopilotApiUrl(payload.endpoints?.api) ??
          this.state?.detectedAccountType;
        return {
          token: payload.token,
          expiresAtUnix: payload.expires_at,
          detectedAccountType
        };
      }

      // Non-OK response. Capture body once so the error message is informative
      // whether we retry or fail here.
      const responseBody = await response.text();
      const snippet = responseBody.slice(0, 256);
      lastStatusError = new CopilotTokenExchangeError(
        `Copilot token exchange failed (${response.status}).`,
        response.status,
        snippet
      );

      if (isTerminalCredentialStatus(response.status)) {
        // Bad OAuth token, account disabled, or endpoint missing — no amount
        // of retry will fix any of these. Throw immediately so the user gets
        // a fast, actionable signal.
        throw lastStatusError;
      }

      if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
        await this.sleepImpl(retryDelayMs(attempt));
        continue;
      }

      throw lastStatusError;
    }

    // Unreachable: every loop iteration either returns, throws, or continues
    // (and the continue branch is gated by `attempt < this.maxAttempts`, so
    // the final iteration always takes one of the throwing branches). Defend
    // anyway so a future refactor doesn't silently drop the error.
    throw lastStatusError ?? lastErrorThrown ?? new Error("Copilot token exchange exhausted retries without error context.");
  }

  private normalizeEnsureTokenOptions(input?: boolean | EnsureTokenOptions): Required<EnsureTokenOptions> {
    if (typeof input === "boolean") {
      return {
        forceRefresh: input,
        refreshThresholdSeconds: DEFAULT_REFRESH_THRESHOLD_SECONDS
      };
    }
    return {
      forceRefresh: input?.forceRefresh ?? false,
      refreshThresholdSeconds: input?.refreshThresholdSeconds ?? DEFAULT_REFRESH_THRESHOLD_SECONDS
    };
  }

  private async refreshToken(): Promise<TokenState> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.exchange()
        .then((next) => {
          this.state = next;
          return next;
        })
        .finally(() => {
          this.refreshInFlight = null;
        });
    }
    return this.refreshInFlight;
  }

  private nowUnix(): number {
    return Math.floor(Date.now() / 1000);
  }
}
