import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { distTagsUrl, fetchLatestNpmVersion, isNewerVersion, maybeNotifyAboutUpdate } from "../../../src/cli/updateNotifier.js";

const packageInfo = { name: "copillm", version: "0.2.4" };

describe("update notifier", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queries the npm dist-tags endpoint with a 3 second abort signal", async () => {
    let requestUrl = "";
    let requestSignal: AbortSignal | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestSignal = init?.signal instanceof AbortSignal ? init.signal : null;
      return new Response(JSON.stringify({ latest: "0.2.5" }), { status: 200 });
    };

    await expect(fetchLatestNpmVersion("copillm", { fetchImpl, timeoutMs: 3_000 })).resolves.toBe("0.2.5");
    expect(requestUrl).toBe("https://registry.npmjs.org/-/package/copillm/dist-tags");
    expect(requestSignal).toBeInstanceOf(AbortSignal);
  });

  it("notifies on the current startup when npm has a newer version", async () => {
    const cacheFilePath = tempCacheFile(tempDirs);
    const writes: string[] = [];
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ latest: "0.2.5" }), { status: 200 });

    await maybeNotifyAboutUpdate({
      packageInfo,
      cacheFilePath,
      env: {},
      moduleUrl: npmInstalledModuleUrl(),
      now: () => 42,
      stderr: { isTTY: true, write: (chunk) => writes.push(chunk) },
      fetchImpl
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
      const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ latest }), { status: 200 });

      await maybeNotifyAboutUpdate({
        packageInfo,
        cacheFilePath: tempCacheFile(tempDirs),
        env: {},
        moduleUrl: npmInstalledModuleUrl(),
        stderr: { isTTY: true, write: (chunk) => writes.push(chunk) },
        fetchImpl
      });

      expect(writes).toEqual([]);
    }
  });

  it("does not check from a source checkout unless explicitly enabled", async () => {
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ latest: "0.2.5" }), { status: 200 });
    };

    await maybeNotifyAboutUpdate({
      packageInfo,
      cacheFilePath: tempCacheFile(tempDirs),
      moduleUrl: sourceCheckoutModuleUrl(),
      stderr: { isTTY: true, write: () => undefined },
      fetchImpl
    });

    expect(fetchCount).toBe(0);
  });

  it("can be forced on for non-npm-managed runtimes", async () => {
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ latest: "0.2.5" }), { status: 200 });
    };

    await maybeNotifyAboutUpdate({
      packageInfo,
      cacheFilePath: tempCacheFile(tempDirs),
      env: { COPILLM_UPDATE_CHECK: "1" },
      moduleUrl: "file:///opt/copillm/copillm",
      stderr: { isTTY: true, write: () => undefined },
      fetchImpl
    });

    expect(fetchCount).toBe(1);
  });

  it("skips internal daemon and non-tty runs", async () => {
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ latest: "0.2.5" }), { status: 200 });
    };

    await maybeNotifyAboutUpdate({
      packageInfo,
      argv: ["node", "cli.js", "daemon"],
      cacheFilePath: tempCacheFile(tempDirs),
      moduleUrl: npmInstalledModuleUrl(),
      stderr: { isTTY: true, write: () => undefined },
      fetchImpl
    });
    await maybeNotifyAboutUpdate({
      packageInfo,
      cacheFilePath: tempCacheFile(tempDirs),
      moduleUrl: npmInstalledModuleUrl(),
      stderr: { isTTY: false, write: () => undefined },
      fetchImpl
    });

    expect(fetchCount).toBe(0);
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

  it("builds scoped npm dist-tags URLs", () => {
    expect(distTagsUrl("@scope/pkg", "https://registry.example.test/")).toBe(
      "https://registry.example.test/-/package/%40scope%2Fpkg/dist-tags"
    );
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
