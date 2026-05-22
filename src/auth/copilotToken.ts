import type { TokenState } from "../types/index.js";
import { tokenExchangeUrl } from "../config/upstream.js";

interface TokenExchangeResponse {
  token: string;
  expires_at: number;
}

interface EnsureTokenOptions {
  forceRefresh?: boolean;
  refreshThresholdSeconds?: number;
}

const DEFAULT_REFRESH_THRESHOLD_SECONDS = 300;
const MIN_ACCEPTABLE_TTL_SECONDS = 30;

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

export class CopilotTokenManager {
  private state: null | TokenState = null;
  private refreshInFlight: null | Promise<TokenState> = null;

  public constructor(private readonly githubToken: string) {}

  public get current(): null | TokenState {
    return this.state;
  }

  public expiresInSeconds(nowUnix = this.nowUnix()): null | number {
    if (!this.state) {
      return null;
    }
    return Math.max(0, this.state.expiresAtUnix - nowUnix);
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

  private async exchange(): Promise<TokenState> {
    const response = await fetch(tokenExchangeUrl(), {
      method: "GET",
      headers: {
        Authorization: `token ${this.githubToken}`,
        "User-Agent": "copillm/0.1.0",
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      const responseBody = await response.text();
      const snippet = responseBody.slice(0, 256);
      throw new CopilotTokenExchangeError(
        `Copilot token exchange failed (${response.status}).`,
        response.status,
        snippet
      );
    }
    const payload = (await response.json()) as TokenExchangeResponse;
    if (!payload.token || !payload.expires_at || !Number.isFinite(payload.expires_at)) {
      throw new CopilotTokenPayloadError("Token exchange response was missing required fields.");
    }
    const now = this.nowUnix();
    const ttl = payload.expires_at - now;
    if (ttl <= MIN_ACCEPTABLE_TTL_SECONDS) {
      throw new CopilotTokenExpiredError(`Received near-expired Copilot token (ttl_seconds=${Math.max(0, ttl)}).`);
    }
    return {
      token: payload.token,
      expiresAtUnix: payload.expires_at
    };
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
