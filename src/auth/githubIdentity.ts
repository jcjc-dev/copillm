import { loadStoredCredential } from "./credentials.js";
import { getGithubUserSummary, GithubUserFetchError } from "../server/debugInfo.js";

/**
 * Minimal, non-secret view of the GitHub account behind the stored credential.
 * Intentionally narrower than GithubUserSummary so callers in user-facing
 * surfaces (e.g. `auth status`) only see what's safe to print — never the
 * token, never email/plan/account-id fields that weren't asked for.
 */
export interface GithubIdentitySummary {
  login: string;
  name: null | string;
}

/**
 * Inspection-style wrapper around loadStoredCredential + getGithubUserSummary
 * that resolves the GitHub identity without ever exposing the token to the
 * caller.
 *
 * Designed for the `auth status` code path: see the repo guideline
 * "Don't wire status surfaces through loadStoredCredential". This helper is
 * the only place the bearer touches the network from that code path, and the
 * return value is shaped so the secret can't escape it.
 *
 * On any failure (no credential, network error, timeout, HTTP error) returns
 * null so callers can gracefully fall back to existing offline output.
 */
export async function inspectGithubIdentity(
  options: { timeoutMs?: number } = {}
): Promise<null | GithubIdentitySummary> {
  let credential: Awaited<ReturnType<typeof loadStoredCredential>>;
  try {
    credential = await loadStoredCredential();
  } catch {
    return null;
  }
  if (!credential) {
    return null;
  }

  try {
    const summary = await getGithubUserSummary(credential.token, {
      timeoutMs: options.timeoutMs ?? 4_000
    });
    if (!summary.login) {
      return null;
    }
    return { login: summary.login, name: summary.name };
  } catch (error) {
    if (error instanceof GithubUserFetchError) {
      return null;
    }
    return null;
  }
}
