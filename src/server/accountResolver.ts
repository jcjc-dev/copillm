import type { AccountType } from "../types/index.js";
import { CopilotTokenManager } from "../auth/copilotToken.js";
import { loadStoredCredentialForAccount } from "../auth/credentials.js";
import { findAccount } from "../auth/accounts.js";

/**
 * Everything the proxy needs to serve one request on behalf of one account:
 * the GitHub OAuth token (used for model discovery), the bearer token manager
 * (used for the upstream chat/responses calls), the account plan type (selects
 * the upstream base URL), and the model-cache id.
 *
 * `accountId === null` and `cacheId === undefined` denote the primary/legacy
 * account — the single account every pre-multi-account install has. Named
 * accounts carry their id and cache into `models.cache.<id>.json`.
 */
export interface ResolvedAccount {
  accountId: string | null;
  githubToken: string;
  tokenManager: CopilotTokenManager;
  accountType: AccountType;
  cacheId: string | undefined;
}

/**
 * Resolves a request's target account. The daemon holds one of these for its
 * lifetime. The `default` account is resolved eagerly at startup; named
 * accounts are resolved (and their bearer managers built) lazily on first use.
 */
export interface AccountResolver {
  readonly default: ResolvedAccount;
  /** Resolve a named account, or `null` if no credential is stored for it. */
  resolveById(accountId: string): Promise<ResolvedAccount | null>;
  /** Introspection for `/_debug`. Never includes tokens. */
  describe(): { defaultAccountId: string | null; activeAccountIds: string[] };
  /** Clear every in-memory bearer (on daemon shutdown). */
  clearAll(): void;
}

/**
 * A resolver that knows only the default account. Used to preserve the exact
 * single-account behaviour when the proxy is started without a multi-account
 * resolver (e.g. test harnesses). A prefixed request for any other account
 * resolves to `null` → the proxy returns `account_not_found`.
 */
export function singleAccountResolver(input: {
  tokenManager: CopilotTokenManager;
  githubToken: string;
  accountType: AccountType;
  accountId?: string | null;
  cacheId?: string;
}): AccountResolver {
  const def: ResolvedAccount = {
    accountId: input.accountId ?? null,
    githubToken: input.githubToken,
    tokenManager: input.tokenManager,
    accountType: input.accountType,
    cacheId: input.cacheId
  };
  return {
    default: def,
    async resolveById(accountId: string): Promise<ResolvedAccount | null> {
      if (def.accountId !== null && accountId === def.accountId) {
        return def;
      }
      return null;
    },
    describe() {
      return { defaultAccountId: def.accountId, activeAccountIds: [] };
    },
    clearAll() {
      def.tokenManager.clear();
    }
  };
}

/**
 * The production resolver. Wraps the eagerly-built default account and lazily
 * builds a bearer manager per named account the first time a request for it
 * arrives. Bearer managers are cached for the daemon's lifetime so repeated
 * requests reuse the same (refresh-coalescing) manager.
 */
export class DaemonAccountResolver implements AccountResolver {
  public readonly default: ResolvedAccount;
  private readonly cache = new Map<string, ResolvedAccount>();
  private readonly createTokenManager: (githubToken: string) => CopilotTokenManager;

  public constructor(input: {
    default: ResolvedAccount;
    /** Test seam: override how bearer managers are constructed. */
    createTokenManager?: (githubToken: string) => CopilotTokenManager;
  }) {
    this.default = input.default;
    this.createTokenManager = input.createTokenManager ?? ((githubToken) => new CopilotTokenManager(githubToken));
  }

  public async resolveById(accountId: string): Promise<ResolvedAccount | null> {
    if (this.default.accountId !== null && accountId === this.default.accountId) {
      return this.default;
    }
    const cached = this.cache.get(accountId);
    if (cached) {
      return cached;
    }
    const credential = await loadStoredCredentialForAccount(accountId);
    if (!credential) {
      return null;
    }
    const record = findAccount(accountId);
    // The cache file follows the account's storage scheme, mirroring the
    // credential store: a legacy-storage account shares `models.cache.json`,
    // a namespaced account gets its own `models.cache.<id>.json`.
    const cacheId = record && record.storage === "legacy" ? undefined : accountId;
    const resolved: ResolvedAccount = {
      accountId,
      githubToken: credential.token,
      tokenManager: this.createTokenManager(credential.token),
      accountType: credential.accountType,
      cacheId
    };
    this.cache.set(accountId, resolved);
    return resolved;
  }

  public describe(): { defaultAccountId: string | null; activeAccountIds: string[] } {
    return { defaultAccountId: this.default.accountId, activeAccountIds: [...this.cache.keys()] };
  }

  public clearAll(): void {
    this.default.tokenManager.clear();
    for (const resolved of this.cache.values()) {
      resolved.tokenManager.clear();
    }
    this.cache.clear();
  }
}
