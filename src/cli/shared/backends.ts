import type { CredentialBackend } from "../../auth/credentials.js";
import type { GithubIdentitySummary } from "../../auth/githubIdentity.js";

export function describeBackend(backend: null | CredentialBackend): string {
  switch (backend) {
    case "keyring":
      return "OS keychain";
    case "file":
      return "credentials file";
    case "session":
      return "in-memory (session only)";
    default:
      return "no backend";
  }
}

export function formatHumanAuthStatusLine(
  backend: null | CredentialBackend,
  identity: null | GithubIdentitySummary
): string {
  if (!identity) {
    return `logged in (${describeBackend(backend)})`;
  }
  const nameSuffix = identity.name && identity.name !== identity.login ? ` (${identity.name})` : "";
  return `logged in as @${identity.login}${nameSuffix} (${describeBackend(backend)})`;
}

export function writeAuthStatusLine(authInfo: {
  stored: boolean;
  backend: null | CredentialBackend;
  error: null | string;
}): void {
  if (authInfo.error) {
    process.stdout.write(`auth: error (${authInfo.error})\n`);
    return;
  }
  if (authInfo.stored) {
    process.stdout.write(`auth: logged in (${describeBackend(authInfo.backend)})\n`);
  } else {
    process.stdout.write("auth: not logged in\n");
  }
}
