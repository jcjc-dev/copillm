import type { AccountType } from "../types/index.js";

const PROD_COPILOT_BASE_URLS: Record<AccountType, string> = {
  individual: "https://api.githubcopilot.com",
  business: "https://api.business.githubcopilot.com",
  enterprise: "https://api.enterprise.githubcopilot.com"
};

const PROD_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const PROD_GITHUB_USER_URL = "https://api.github.com/user";

export function copilotBaseUrl(accountType: AccountType): string {
  const override = readEnv("COPILLM_UPSTREAM_BASE_URL");
  if (override) {
    return stripTrailingSlash(override);
  }
  return PROD_COPILOT_BASE_URLS[accountType];
}

export function tokenExchangeUrl(): string {
  const override = readEnv("COPILLM_TOKEN_EXCHANGE_URL");
  if (override) {
    return override;
  }
  return PROD_TOKEN_EXCHANGE_URL;
}

export function githubUserUrl(): string {
  const override = readEnv("COPILLM_GITHUB_USER_URL");
  if (override) {
    return override;
  }
  return PROD_GITHUB_USER_URL;
}

function readEnv(name: string): null | string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
