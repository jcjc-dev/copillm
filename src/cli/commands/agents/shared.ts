import type { ApplyResult } from "../../../agentconfig/render.js";
import { applyYolo, resolveYoloWithSource } from "../../../agents/registry.js";
import type { AgentName } from "../../../integrations/registry.js";
import { loadAgentConfig } from "../../../agentconfig/load.js";
import { findAccount, readAccountsIndex } from "../../../auth/accounts.js";
import { assertValidAccountId } from "../../../config/accountId.js";
import {
  loadStoredCredential,
  loadStoredCredentialForAccount,
  type StoredCredential
} from "../../../auth/credentials.js";
import { inspectGithubIdentity } from "../../../auth/githubIdentity.js";
import type { AccountDiscoveryOverride } from "../../../integrations/codex/init.js";

/**
 * A launch resolved to a specific (named) copillm account. `pathPrefix` is the
 * `/<account>` segment to inject before the agent's base-URL route so the
 * daemon serves the request with that account's bearer; `account` carries the
 * token + cache id used to discover that account's model catalog.
 */
export interface ResolvedLaunchAccount {
  accountId: string;
  pathPrefix: string;
  cacheId: string | undefined;
  account: AccountDiscoveryOverride;
  source: "flag" | "env" | "profile";
}

/**
 * Resolve which account a launch targets, applying precedence
 * `--account` > `COPILLM_ACCOUNT` > the active profile's `account` > default.
 * Returns null for the default account (no prefix — today's behaviour).
 *
 * Throws a user-facing Error when a requested account is malformed, not
 * registered, or has no stored credential, so the launcher can fail fast
 * before starting the daemon or the agent.
 */
export async function resolveLaunchAccount(input: {
  flag?: string;
  envValue?: string;
  cwd: string;
  profileOverride: string | null;
}): Promise<ResolvedLaunchAccount | null> {
  let requested: string | undefined;
  let source: ResolvedLaunchAccount["source"];

  if (input.flag && input.flag.trim().length > 0) {
    requested = input.flag.trim();
    source = "flag";
  } else if (input.envValue && input.envValue.trim().length > 0) {
    requested = input.envValue.trim();
    source = "env";
  } else {
    const config = loadAgentConfig({ cwd: input.cwd, profileOverride: input.profileOverride });
    const pinned = config?.resolved.account ?? null;
    if (pinned) {
      requested = pinned;
      source = "profile";
    }
  }

  if (!requested) {
    return null;
  }

  assertValidAccountId(requested);
  const record = findAccount(requested);
  if (!record) {
    // A single-account install has no accounts index, so the sole (legacy)
    // credential has no entry to resolve by id. If the requested login matches
    // that account's GitHub login, route it as the default account instead of
    // failing — this lets a profile pin the only account before a second login
    // materializes an index. With an index, an unregistered account is still
    // genuinely unknown and falls through to the error below.
    const legacy = await resolveLegacyMatch(requested);
    if (legacy) {
      return {
        accountId: requested,
        pathPrefix: "",
        cacheId: undefined,
        account: { accountType: legacy.accountType, githubToken: legacy.token, cacheId: undefined },
        source: source!
      };
    }
    throw new Error(`Unknown account "${requested}". Run \`copillm auth status\` to list accounts.`);
  }
  const credential = await loadStoredCredentialForAccount(requested);
  if (!credential) {
    throw new Error(`No stored credential for account "${requested}". Run \`copillm auth login --as ${requested}\`.`);
  }
  const cacheId = record.storage === "legacy" ? undefined : requested;
  return {
    accountId: requested,
    pathPrefix: `/${requested}`,
    cacheId,
    account: { accountType: credential.accountType, githubToken: credential.token, cacheId },
    source: source!
  };
}

/**
 * When no accounts index exists, check whether the requested id matches the
 * sole (legacy) credential's GitHub login. Returns the credential on a match so
 * the caller can route it as the default account, or null when there's no
 * index-independent way to treat `requested` as an existing account.
 */
async function resolveLegacyMatch(requested: string): Promise<null | StoredCredential> {
  // A real multi-account index means an unregistered id is genuinely unknown.
  if (readAccountsIndex()) {
    return null;
  }
  const credential = await loadStoredCredential();
  if (!credential) {
    return null;
  }
  const identity = await inspectGithubIdentity({ token: credential.token });
  if (!identity || identity.login !== requested) {
    return null;
  }
  return credential;
}

export function formatLaunchAccountNotice(resolved: ResolvedLaunchAccount): string {
  const from =
    resolved.source === "flag" ? "--account" : resolved.source === "env" ? "COPILLM_ACCOUNT" : "profile";
  return `copillm: using account "${resolved.accountId}" (from ${from})`;
}

/**
 * Shared yolo wiring for the four agent subcommands. Resolves precedence
 * (flag > env > profile > defaults > off), runs `applyYolo` with source
 * attribution so the unsupported-agent warning carries traceable origin
 * info, and emits a one-line stderr notice when yolo was turned on by a
 * config layer rather than the explicit --yolo flag (so users aren't
 * surprised by silently-skipped approvals).
 */
export function applyYoloForLaunch(params: {
  agent: AgentName;
  flag: boolean | undefined;
  applyResult: ApplyResult;
  baseArgs: string[];
}): string[] {
  const decision = resolveYoloWithSource({
    agent: params.agent,
    flag: params.flag,
    profile: {
      yolo: params.applyResult.yolo,
      profileName: params.applyResult.active
    }
  });
  if (decision.value && decision.source !== "flag" && decision.source !== "env") {
    process.stderr.write(
      `copillm: yolo enabled for ${params.agent} via ${decision.label}\n`
    );
  }
  return applyYolo({
    agent: params.agent,
    userArgs: params.baseArgs,
    yolo: decision.value,
    source: decision.source
  });
}
