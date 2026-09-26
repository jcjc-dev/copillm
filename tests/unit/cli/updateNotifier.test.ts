import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchLatestNpmVersion,
  isNewerVersion,
  maybeNotifyAboutUpdate,
  type NpmCommandRunner
} from "../../../src/cli/updateNotifier.js";

const packageInfo = { name: "copillm", version: "0.2.4" };
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

describe("update notifier", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the user-level npm registry and stops when it returns a version", async () => {
    const calls: { args: string[]; cwd: string; registry: string | undefined }[] = [];
    const npmRunner: NpmCommandRunner = async (_executable, args, options) => {
      calls.push({ args, cwd: options.cwd, registry: options.env.npm_config_registry });
      if (args[0] === "config") {
        return { exitCode: 0, stdout: "https://registry.example.test/npm/\n" };
      }
      return { exitCode: 0, stdout: JSON.stringify("0.2.5") };
    };

    await expect(fetchLatestNpmVersion("copillm", {
      env: {},
      npmExecutable: "fake-npm",
      npmRunner,
      timeoutMs: 3_000
    })).resolves.toBe("0.2.5");
    expect(calls.map((call) => call.args[0])).toEqual(["config", "view"]);
    expect(calls[0]?.args).toContain("--location=user");
    expect(calls.map((call) => call.cwd)).toEqual([os.homedir(), os.homedir()]);
    expect(calls[1]?.registry).toBe("https://registry.example.test/npm/");
    expect(calls[1]?.args).toContain("--fetch-timeout=3000");
    expect(calls[1]?.args).toContain("--fetch-retries=0");
  });

  it("falls back to npmjs.org only when the user-level registry lookup fails", async () => {
    const registries: string[] = [];
    const npmRunner: NpmCommandRunner = async (_executable, args, options) => {
      if (args[0] === "config") {
        return { exitCode: 0, stdout: "https://registry.example.test/npm/" };
      }
      const registry = options.env.npm_config_registry ?? "";
      registries.push(registry);
      return registry === PUBLIC_REGISTRY
        ? { exitCode: 0, stdout: JSON.stringify("0.2.5") }
        : { exitCode: 1, stdout: "" };
    };

    await expect(fetchLatestNpmVersion("copillm", {
      env: {},
      npmExecutable: "fake-npm",
      npmRunner
    })).resolves.toBe("0.2.5");
    expect(registries).toEqual(["https://registry.example.test/npm/", PUBLIC_REGISTRY]);
  });

  it("does not retry npmjs.org when it is already the primary registry", async () => {
    const viewRegistries: string[] = [];
    const npmRunner: NpmCommandRunner = async (_executable, args, options) => {
      if (args[0] === "config") {
        return { exitCode: 0, stdout: PUBLIC_REGISTRY };
      }
      viewRegistries.push(options.env.npm_config_registry ?? "");
      return { exitCode: 1, stdout: "" };
    };

    await expect(fetchLatestNpmVersion("copillm", {
      env: {},
      npmExecutable: "fake-npm",
      npmRunner
    })).resolves.toBeNull();
    expect(viewRegistries).toEqual([PUBLIC_REGISTRY]);
  });

  it("uses the explicit registry override before the user-level registry", async () => {
    const calls: { args: string[]; registry: string | undefined }[] = [];
    const npmRunner: NpmCommandRunner = async (_executable, args, options) => {
      calls.push({ args, registry: options.env.npm_config_registry });
      if (args[0] === "view" && options.env.npm_config_registry === "https://override.example.test/") {
        return { exitCode: 1, stdout: "" };
      }
      return { exitCode: 0, stdout: JSON.stringify("0.2.5") };
    };

    await expect(fetchLatestNpmVersion("copillm", {
      env: {},
      npmExecutable: "fake-npm",
      npmRunner,
      registryUrl: "https://override.example.test/"
    })).resolves.toBe("0.2.5");
    expect(calls.filter((call) => call.args[0] === "config")).toHaveLength(0);
    expect(calls.filter((call) => call.args[0] === "view").map((call) => call.registry)).toEqual([
      "https://override.example.test/",
      PUBLIC_REGISTRY
    ]);
  });

  it("runs npm with the user config and selected registry", async () => {
    const cacheFilePath = tempCacheFile(tempDirs);
    const dir = path.dirname(cacheFilePath);
    const userConfigPath = path.join(dir, "user.npmrc");
    const callsPath = path.join(dir, "npm-calls.jsonl");
    fs.writeFileSync(userConfigPath, "");
    const npmExecutable = fakeNpmExecutable(dir, callsPath);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      ComSpec: process.env.ComSpec,
      COMSPEC: process.env.COMSPEC,
      SystemRoot: process.env.SystemRoot,
      npm_config_userconfig: userConfigPath,
      FAKE_NPM_REGISTRY: "https://registry.example.test/npm/"
    };

    await expect(fetchLatestNpmVersion("copillm", { env, npmExecutable })).resolves.toBe("0.2.5");

    const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; registry: string | undefined });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("--location=user");
    expect(calls[0]?.args).toContain("--userconfig");
    expect(calls[0]?.args).toContain(userConfigPath);
    expect(calls[1]?.args[0]).toBe("view");
    expect(calls[1]?.registry).toBe("https://registry.example.test/npm/");
  });

  it("notifies on the current startup when npm has a newer version", async () => {
    const cacheFilePath = tempCacheFile(tempDirs);
    const writes: string[] = [];
    await maybeNotifyAboutUpdate({
      packageInfo,
      cacheFilePath,
      env: {},
      moduleUrl: npmInstalledModuleUrl(),
      now: () => 42,
      stderr: { isTTY: true, write: (chunk) => writes.push(chunk) },
      npmRunner: npmRunnerForVersion("0.2.5")
    });

    expect(writes.join("")).toContain("copillm 0.2.5 is available (current 0.2.4).");
    expect(writes.join("")).toContain("npm install -g copillm");
    expect(writes.join("")).toContain("https://github.com/jcjc-dev/copillm/releases/latest");
    expect(JSON.parse(fs.readFileSync(cacheFilePath, "utf8"))).toMatchObject({
      packageName: "copillm",
      latestVersion: "0.2.5",
      checkedAt: 42
    });
  });

  it("does not notify when npm returns equal, older, or invalid versions", async () => {
    for (const latest of ["0.2.4", "0.2.3", "not-a-version"]) {
      const writes: string[] = [];
      await maybeNotifyAboutUpdate({
        packageInfo,
        cacheFilePath: tempCacheFile(tempDirs),
        env: {},
        moduleUrl: npmInstalledModuleUrl(),
        stderr: { isTTY: true, write: (chunk) => writes.push(chunk) },
        npmRunner: npmRunnerForVersion(latest)
      });

      expect(writes).toEqual([]);
    }
  });

  it("does not check from a source checkout unless explicitly enabled", async () => {
    let npmCallCount = 0;
    const npmRunner: NpmCommandRunner = async () => {
      npmCallCount += 1;
      return { exitCode: 0, stdout: JSON.stringify("0.2.5") };
    };

    await maybeNotifyAboutUpdate({
      packageInfo,
      cacheFilePath: tempCacheFile(tempDirs),
      moduleUrl: sourceCheckoutModuleUrl(),
      stderr: { isTTY: true, write: () => undefined },
      npmRunner
    });

    expect(npmCallCount).toBe(0);
  });

  it("can be forced on for non-npm-managed runtimes", async () => {
    let npmCallCount = 0;
    const npmRunner: NpmCommandRunner = async (_executable, args) => {
      npmCallCount += 1;
      return args[0] === "config"
        ? { exitCode: 0, stdout: PUBLIC_REGISTRY }
        : { exitCode: 0, stdout: JSON.stringify("0.2.5") };
    };

    await maybeNotifyAboutUpdate({
      packageInfo,
      cacheFilePath: tempCacheFile(tempDirs),
      env: { COPILLM_UPDATE_CHECK: "1" },
      moduleUrl: "file:///opt/copillm/copillm",
      stderr: { isTTY: true, write: () => undefined },
      npmRunner
    });

    expect(npmCallCount).toBe(2);
  });

  it("skips internal daemon and non-tty runs", async () => {
    let npmCallCount = 0;
    const npmRunner: NpmCommandRunner = async () => {
      npmCallCount += 1;
      return { exitCode: 0, stdout: JSON.stringify("0.2.5") };
    };

    await maybeNotifyAboutUpdate({
      packageInfo,
      argv: ["node", "cli.js", "daemon"],
      cacheFilePath: tempCacheFile(tempDirs),
      moduleUrl: npmInstalledModuleUrl(),
      stderr: { isTTY: true, write: () => undefined },
      npmRunner
    });
    await maybeNotifyAboutUpdate({
      packageInfo,
      cacheFilePath: tempCacheFile(tempDirs),
      moduleUrl: npmInstalledModuleUrl(),
      stderr: { isTTY: false, write: () => undefined },
      npmRunner
    });

    expect(npmCallCount).toBe(0);
  });

  it("compares semver versions without treating prereleases as newer than stable", () => {
    expect(isNewerVersion("0.2.5", "0.2.4")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.2.9")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.2.4", "0.2.5")).toBe(false);
    expect(isNewerVersion("0.2.4-custom", "0.2.4")).toBe(false);
    expect(isNewerVersion("not-a-version", "0.2.4")).toBe(false);
    expect(isNewerVersion("0.2.5", "not-a-version")).toBe(false);
  });
});

function tempCacheFile(tempDirs: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-update-test-"));
  tempDirs.push(dir);
  return path.join(dir, "update-check.json");
}

function npmInstalledModuleUrl(): string {
  return pathToFileURL(path.join(os.tmpdir(), "node_modules", "copillm", "dist", "cli", "updateNotifier.js")).href;
}

function sourceCheckoutModuleUrl(): string {
  return pathToFileURL(path.join(os.tmpdir(), "copillm", "dist", "cli", "updateNotifier.js")).href;
}

function npmRunnerForVersion(version: string): NpmCommandRunner {
  return async (_executable, args) => args[0] === "config"
    ? { exitCode: 0, stdout: PUBLIC_REGISTRY }
    : { exitCode: 0, stdout: JSON.stringify(version) };
}

function fakeNpmExecutable(dir: string, callsPath: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const implementation = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  args,
  registry: process.env.npm_config_registry
}) + "\\n");
if (args[0] === "config") {
  process.stdout.write(process.env.FAKE_NPM_REGISTRY + "\\n");
} else if (args[0] === "view") {
  process.stdout.write(JSON.stringify("0.2.5") + "\\n");
} else {
  process.exitCode = 2;
}
`;
  if (process.platform === "win32") {
    const jsPath = path.join(dir, "fake-npm-impl.js");
    const cmdPath = path.join(dir, "fake-npm.cmd");
    fs.writeFileSync(jsPath, implementation);
    fs.writeFileSync(cmdPath, `@node "${jsPath}" %*\r\n`);
    return cmdPath;
  }
  const scriptPath = path.join(dir, "fake-npm");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${implementation}`, { mode: 0o755 });
  return scriptPath;
}
