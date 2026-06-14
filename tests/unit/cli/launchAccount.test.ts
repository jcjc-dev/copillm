import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PR F — resolveLaunchAccount precedence + validation, and the per-account
 * URL-prefix injection into the agent base URLs.
 */

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-launch-acct-"));
  savedEnv.COPILLM_HOME = process.env.COPILLM_HOME;
  savedEnv.COPILLM_FORCE_SESSION_BACKEND = process.env.COPILLM_FORCE_SESSION_BACKEND;
  savedEnv.COPILLM_ACCOUNT = process.env.COPILLM_ACCOUNT;
  process.env.COPILLM_HOME = tmpHome;
  process.env.COPILLM_FORCE_SESSION_BACKEND = "1";
  delete process.env.COPILLM_ACCOUNT;
  const creds = await import("../../../src/auth/credentials.js");
  creds.__resetSessionCredentialForTests();
});

afterEach(() => {
  for (const key of ["COPILLM_HOME", "COPILLM_FORCE_SESSION_BACKEND", "COPILLM_ACCOUNT"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function seedAccounts(): Promise<void> {
  const { addAccount } = await import("../../../src/auth/accountManager.js");
  await addAccount({ id: "octocat", accountType: "individual", token: "tok-octocat", mode: "session" });
  await addAccount({ id: "work", accountType: "business", token: "tok-work", mode: "session" });
}

function writeAgentToml(body: string): void {
  fs.writeFileSync(path.join(tmpHome, "agent.toml"), body, "utf8");
}

describe("resolveLaunchAccount precedence", () => {
  it("returns null when nothing selects an account (default)", async () => {
    await seedAccounts();
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    const r = await resolveLaunchAccount({ cwd: tmpHome, profileOverride: null });
    expect(r).toBeNull();
  });

  it("uses the --account flag with highest precedence", async () => {
    await seedAccounts();
    process.env.COPILLM_ACCOUNT = "octocat";
    writeAgentToml('active_profile = "p"\n[profiles.p]\naccount = "octocat"\n');
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    const r = await resolveLaunchAccount({ flag: "work", envValue: process.env.COPILLM_ACCOUNT, cwd: tmpHome, profileOverride: "p" });
    expect(r?.accountId).toBe("work");
    expect(r?.source).toBe("flag");
    expect(r?.pathPrefix).toBe("/work");
    expect(r?.cacheId).toBe("work");
    expect(r?.account.githubToken).toBe("tok-work");
    expect(r?.account.accountType).toBe("business");
  });

  it("falls back to COPILLM_ACCOUNT when no flag is given", async () => {
    await seedAccounts();
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    const r = await resolveLaunchAccount({ envValue: "work", cwd: tmpHome, profileOverride: null });
    expect(r?.accountId).toBe("work");
    expect(r?.source).toBe("env");
  });

  it("falls back to the profile's pinned account", async () => {
    await seedAccounts();
    writeAgentToml('active_profile = "work-profile"\n[profiles.work-profile]\naccount = "work"\n');
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    const r = await resolveLaunchAccount({ cwd: tmpHome, profileOverride: "work-profile" });
    expect(r?.accountId).toBe("work");
    expect(r?.source).toBe("profile");
  });

  it("uses the legacy cache id (undefined) for the legacy-storage account", async () => {
    await seedAccounts();
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    const r = await resolveLaunchAccount({ flag: "octocat", cwd: tmpHome, profileOverride: null });
    expect(r?.cacheId).toBeUndefined();
    expect(r?.account.cacheId).toBeUndefined();
  });

  it("throws for an unknown account", async () => {
    await seedAccounts();
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    await expect(resolveLaunchAccount({ flag: "ghost", cwd: tmpHome, profileOverride: null })).rejects.toThrow(
      /Unknown account "ghost"/
    );
  });

  it("throws for a path-unsafe account id", async () => {
    await seedAccounts();
    const { resolveLaunchAccount } = await import("../../../src/cli/commands/agents/shared.js");
    await expect(resolveLaunchAccount({ flag: "../evil", cwd: tmpHome, profileOverride: null })).rejects.toThrow(
      /Invalid account id/
    );
  });
});

describe("base-URL prefix injection", () => {
  it("claude env bundle prepends the account prefix to ANTHROPIC_BASE_URL", async () => {
    const { buildClaudeEnvBundle } = await import("../../../src/cli/agentEnv.js");
    const bundle = buildClaudeEnvBundle({ port: 4141, callerSecret: null, pathPrefix: "/work" });
    expect(bundle.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141/work/anthropic");
  });

  it("claude env bundle is unprefixed by default", async () => {
    const { buildClaudeEnvBundle } = await import("../../../src/cli/agentEnv.js");
    const bundle = buildClaudeEnvBundle({ port: 4141, callerSecret: null });
    expect(bundle.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141/anthropic");
  });

  it("codex config writes a prefixed base_url for a named account", async () => {
    const { generateCodexHome, defaultOutputDir } = await import("../../../src/integrations/codex/init.js");
    const outDir = path.join(tmpHome, "codex");
    const result = await generateCodexHome({
      outDir: defaultOutputDir(outDir),
      model: null,
      port: 4141,
      providerId: "copillm",
      reasoningEffort: null,
      pathPrefix: "/work",
      precomputed: {
        config: { preferredPort: 4141, requireCallerSecret: false, selectedModels: [], accountType: "business" },
        creds: { token: "tok", accountType: "business", source: "session" },
        discovery: {
          models: [
            {
              id: "gpt-test",
              model_picker_enabled: true,
              supported_endpoints: ["/responses", "/chat/completions"]
            } as unknown as { id: string }
          ],
          source: "live",
          stale: false,
          cacheAgeSeconds: 0,
          warning: null
        }
      }
    });
    const toml = fs.readFileSync(result.configPath, "utf8");
    expect(toml).toContain('base_url = "http://127.0.0.1:4141/work/codex/v1"');
    expect(result.proxyUrl).toBe("http://127.0.0.1:4141/work/codex/v1");
  });
});

describe("agent.toml account resolution", () => {
  it("resolves a profile-pinned account, project overlay winning over global", async () => {
    writeAgentToml('active_profile = "work"\n[profiles.work]\naccount = "global-acct"\n');
    const projectDir = path.join(tmpHome, "proj");
    fs.mkdirSync(path.join(projectDir, ".copillm"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".copillm", "agent.toml"),
      '[profiles.work]\naccount = "project-acct"\n',
      "utf8"
    );
    const { loadAgentConfig } = await import("../../../src/agentconfig/load.js");
    const result = loadAgentConfig({ cwd: projectDir, profileOverride: "work" });
    expect(result?.resolved.account).toBe("project-acct");
  });

  it("account is null when no layer sets it", async () => {
    writeAgentToml('active_profile = "work"\n[profiles.work]\ninstructions = { body = "hi" }\n');
    const { loadAgentConfig } = await import("../../../src/agentconfig/load.js");
    const result = loadAgentConfig({ cwd: tmpHome, profileOverride: "work" });
    expect(result?.resolved.account).toBeNull();
  });
});
