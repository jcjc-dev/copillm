import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../../src/auth/githubIdentity.js", () => ({
  inspectGithubIdentity: vi.fn(async ({ token }: { token: string }) => {
    if (token === "tok-octocat") return { login: "octocat", name: "Octo Cat" };
    return null;
  })
}));

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-legacy-pin-"));
  savedEnv.COPILLM_HOME = process.env.COPILLM_HOME;
  savedEnv.COPILLM_FORCE_SESSION_BACKEND = process.env.COPILLM_FORCE_SESSION_BACKEND;
  process.env.COPILLM_HOME = tmpHome;
  process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  const creds = await import("../../../src/auth/credentials.js");
  creds.__resetSessionCredentialForTests();
});

afterEach(() => {
  for (const key of ["COPILLM_HOME", "COPILLM_FORCE_SESSION_BACKEND"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeAgentToml(body: string): void {
  fs.writeFileSync(path.join(tmpHome, "agent.toml"), body, "utf8");
}

describe("single-account legacy pinning", () => {
  it("resolves a pinned account matching the sole legacy login", async () => {
    const { saveStoredCredential } = await import("../../../src/auth/credentials.js");
    await saveStoredCredential("tok-octocat", "individual", { mode: "session" });
    writeAgentToml('active_profile = "p"\n[profiles.p]\naccount = "octocat"\n');
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    const r = await resolveLaunchAccount({ cwd: tmpHome, profileOverride: "p" });
    expect(r).not.toBeNull();
    expect(r!.accountId).toBe("octocat");
    expect(r!.source).toBe("profile");
    expect(r!.pathPrefix).toBe("");
    expect(r!.cacheId).toBeUndefined();
    expect(r!.account.githubToken).toBe("tok-octocat");
  });

  it("still throws for an unmatched id on a single-account install", async () => {
    const { saveStoredCredential } = await import("../../../src/auth/credentials.js");
    await saveStoredCredential("tok-octocat", "individual", { mode: "session" });
    writeAgentToml('active_profile = "p"\n[profiles.p]\naccount = "ghost"\n');
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    await expect(resolveLaunchAccount({ cwd: tmpHome, profileOverride: "p" })).rejects.toThrow(
      /Unknown account "ghost"/
    );
  });
});
