import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionScope } from "../../../src/agentconfig/sessionScope.js";

let tmpHome: string;
let tmpCwd: string;
let savedCopillmHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-session-scope-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-session-scope-cwd-"));
  savedCopillmHome = process.env.COPILLM_HOME;
  process.env.COPILLM_HOME = tmpHome;
});

afterEach(() => {
  if (savedCopillmHome === undefined) delete process.env.COPILLM_HOME;
  else process.env.COPILLM_HOME = savedCopillmHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("resolveSessionScope", () => {
  it("uses shared/default paths when no agent.toml exists", () => {
    expect(resolveSessionScope({ cwd: tmpCwd })).toEqual({
      profileName: "default",
      scope: "shared",
      stateRoot: tmpHome
    });
  });

  it("resolves an isolated active profile", () => {
    fs.writeFileSync(
      path.join(tmpHome, "agent.toml"),
      `
active_profile = "personal"
[profiles.personal]
session_scope = "isolated"
`
    );

    expect(resolveSessionScope({ cwd: tmpCwd })).toEqual({
      profileName: "personal",
      scope: "isolated",
      stateRoot: path.join(tmpHome, "profiles", "personal")
    });
  });

  it("uses the explicit profile override for both config and path selection", () => {
    fs.writeFileSync(
      path.join(tmpHome, "agent.toml"),
      `
active_profile = "work"
[profiles.work]
session_scope = "shared"
[profiles.personal]
session_scope = "isolated"
`
    );

    expect(resolveSessionScope({ cwd: tmpCwd, profileOverride: "personal" })).toEqual({
      profileName: "personal",
      scope: "isolated",
      stateRoot: path.join(tmpHome, "profiles", "personal")
    });
  });

  it("fails closed for unsafe names in isolated profiles", () => {
    fs.writeFileSync(
      path.join(tmpHome, "agent.toml"),
      `
active_profile = "../personal"
[profiles."../personal"]
session_scope = "isolated"
`
    );

    expect(() => resolveSessionScope({ cwd: tmpCwd })).toThrow(/profile names/i);
  });
});
