import { describe, expect, it } from "vitest";

import { buildVersionHint, computeVersionStatus } from "../../../../src/cli/daemon/versionStatus.js";
import type { NpmCommandRunner } from "../../../../src/cli/updateNotifier.js";

const PKG = { name: "copillm", version: "0.4.3" };
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

function stubNpmRunner(latestVersion: string | null, fail = false): NpmCommandRunner {
  return async (_executable, args) => {
    if (args[0] === "config") {
      return { exitCode: 0, stdout: PUBLIC_REGISTRY };
    }
    if (fail || latestVersion === null) {
      return { exitCode: 1, stdout: "" };
    }
    return { exitCode: 0, stdout: JSON.stringify(latestVersion) };
  };
}

describe("computeVersionStatus", () => {
  it("reports everything in sync when daemon, cli, and registry agree", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: "0.4.3",
      daemonRunning: true,
      env: {},
      npmRunner: stubNpmRunner("0.4.3")
    });
    expect(result).toMatchObject({
      daemon_version: "0.4.3",
      cli_version: "0.4.3",
      latest_version: "0.4.3",
      update_available: false,
      hint: null
    });
  });

  it("flags `restart to apply` when the daemon is older than the cli on disk", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: "0.4.2",
      daemonRunning: true,
      env: {},
      npmRunner: stubNpmRunner("0.4.3")
    });
    expect(result.update_available).toBe(true);
    expect(result.hint).toBe("restart to apply cli v0.4.3");
  });

  it("flags `newer version available` when the registry has a newer cli release", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: "0.4.3",
      daemonRunning: true,
      env: {},
      npmRunner: stubNpmRunner("0.4.4")
    });
    expect(result.update_available).toBe(true);
    expect(result.hint).toBe("newer version available: v0.4.4 (npm install -g copillm)");
  });

  it("combines both hints when daemon < cli < latest", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: "0.4.2",
      daemonRunning: true,
      env: {},
      npmRunner: stubNpmRunner("0.4.4")
    });
    expect(result.update_available).toBe(true);
    expect(result.hint).toBe(
      "newer version available: v0.4.4 (npm install -g copillm); restart to apply cli v0.4.3"
    );
  });

  it("prompts a restart when the daemon predates the /healthz version field", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: null,
      daemonRunning: true,
      env: {},
      npmRunner: stubNpmRunner("0.4.3")
    });
    expect(result.daemon_version).toBeNull();
    expect(result.update_available).toBe(false);
    expect(result.hint).toBe("restart to start reporting version");
  });

  it("does not nag when the daemon is newer than the cli (local downgrade)", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: "0.5.0",
      daemonRunning: true,
      env: {},
      npmRunner: stubNpmRunner("0.4.3")
    });
    expect(result.update_available).toBe(false);
    expect(result.hint).toBeNull();
  });

  it("skips the registry lookup when noRegistryCheck=true", async () => {
    let called = false;
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: "0.4.3",
      daemonRunning: true,
      noRegistryCheck: true,
      env: {},
      npmRunner: async () => {
        called = true;
        return { exitCode: 0, stdout: JSON.stringify("0.4.3") };
      }
    });
    expect(called).toBe(false);
    expect(result.latest_version).toBeNull();
    expect(result.hint).toBeNull();
  });

  it("skips the registry lookup when NO_UPDATE_NOTIFIER is set", async () => {
    let called = false;
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: "0.4.3",
      daemonRunning: true,
      env: { NO_UPDATE_NOTIFIER: "1" },
      npmRunner: async () => {
        called = true;
        return { exitCode: 0, stdout: JSON.stringify("0.4.3") };
      }
    });
    expect(called).toBe(false);
    expect(result.latest_version).toBeNull();
  });

  it("skips the registry lookup when COPILLM_UPDATE_CHECK is a falsy override", async () => {
    for (const value of ["0", "false", "no", "off"]) {
      let called = false;
      const result = await computeVersionStatus({
        cliPackageInfo: PKG,
        daemonVersion: "0.4.3",
        daemonRunning: true,
        env: { COPILLM_UPDATE_CHECK: value },
        npmRunner: async () => {
          called = true;
          return { exitCode: 0, stdout: JSON.stringify("0.4.3") };
        }
      });
      expect(called, `value=${value}`).toBe(false);
      expect(result.latest_version, `value=${value}`).toBeNull();
    }
  });

  it("treats network failure as a missing latest_version (does not throw)", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: "0.4.2",
      daemonRunning: true,
      env: {},
      npmRunner: stubNpmRunner(null, /* fail */ true)
    });
    expect(result.latest_version).toBeNull();
    // The daemon-vs-cli comparison still surfaces.
    expect(result.hint).toBe("restart to apply cli v0.4.3");
  });

  it("does not surface a restart hint when the daemon is not running", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: null,
      daemonRunning: false,
      env: {},
      npmRunner: stubNpmRunner("0.4.3")
    });
    expect(result.update_available).toBe(false);
    expect(result.hint).toBeNull();
  });

  it("still flags `newer version available` when the daemon is not running but the cli is stale", async () => {
    const result = await computeVersionStatus({
      cliPackageInfo: PKG,
      daemonVersion: null,
      daemonRunning: false,
      env: {},
      npmRunner: stubNpmRunner("0.4.4")
    });
    expect(result.update_available).toBe(true);
    expect(result.hint).toBe("newer version available: v0.4.4 (npm install -g copillm)");
  });
});

describe("buildVersionHint", () => {
  it("returns null when there is nothing to say", () => {
    expect(
      buildVersionHint({
        daemonStale: false,
        cliStale: false,
        daemonReportsNoVersion: false,
        cliVersion: "0.4.3",
        latestVersion: "0.4.3"
      })
    ).toBeNull();
  });

  it("returns null when latestVersion is missing AND nothing else needs surfacing", () => {
    expect(
      buildVersionHint({
        daemonStale: false,
        cliStale: false,
        daemonReportsNoVersion: false,
        cliVersion: "0.4.3",
        latestVersion: null
      })
    ).toBeNull();
  });
});
