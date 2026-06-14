import type { ApplyResult } from "../../../agentconfig/render.js";
import { applyYolo, resolveYoloWithSource } from "../../../agents/registry.js";
import type { AgentName } from "../../../integrations/registry.js";
import { loadAgentConfig } from "../../../agentconfig/load.js";
import { findAccount } from "../../../auth/accounts.js";
import { assertValidAccountId } from "../../../config/accountId.js";
import { loadStoredCredentialForAccount } from "../../../auth/credentials.js";
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
