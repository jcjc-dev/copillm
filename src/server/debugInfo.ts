import { githubUserUrl } from "../config/upstream.js";

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

let cached: { fetchedAt: number; summary: GithubUserSummary } | null = null;

export async function getGithubUserSummary(
  githubToken: string,
  options: { timeoutMs?: number } = {}
): Promise<GithubUserSummary> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.summary;
  }

  const response = await fetch(githubUserUrl(), {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "copillm/0.1.0",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: typeof options.timeoutMs === "number" ? AbortSignal.timeout(options.timeoutMs) : undefined
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new GithubUserFetchError(response.status, detail.slice(0, 256));
  }

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

  cached = { fetchedAt: now, summary };
  return summary;
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
