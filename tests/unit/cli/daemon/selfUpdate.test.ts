import { describe, expect, it, vi } from "vitest";

import { describeSelfUpdate, selfUpdateToLatest } from "../../../../src/cli/daemon/selfUpdate.js";

const PKG = { name: "copillm", version: "0.4.0" };
const GLOBAL_URL = "file:///usr/local/lib/node_modules/copillm/dist/cli/daemon/selfUpdate.js";
const DEV_URL = "file:///Users/dev/copillm/copillm/dist/cli/daemon/selfUpdate.js";

describe("selfUpdateToLatest", () => {
  it("skips when not running from a global npm install", async () => {
    const runInstall = vi.fn(() => ({ ok: true, detail: "" }));
    const result = await selfUpdateToLatest(PKG, {
      moduleUrl: DEV_URL,
      fetchLatest: async () => "9.9.9",
      runInstall
    });
    expect(result).toEqual({ status: "skipped", reason: "not-global" });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("skips when the latest version cannot be fetched", async () => {
    const runInstall = vi.fn(() => ({ ok: true, detail: "" }));
    const result = await selfUpdateToLatest(PKG, {
      moduleUrl: GLOBAL_URL,
      fetchLatest: async () => null,
      runInstall
    });
    expect(result).toEqual({ status: "skipped", reason: "no-latest" });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("skips the install when already on the latest version", async () => {
    const runInstall = vi.fn(() => ({ ok: true, detail: "" }));
    const result = await selfUpdateToLatest(PKG, {
      moduleUrl: GLOBAL_URL,
      fetchLatest: async () => "0.4.0",
      runInstall
    });
    expect(result).toEqual({ status: "up-to-date", version: "0.4.0" });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("installs and reports updated when a newer version exists", async () => {
    const runInstall = vi.fn(() => ({ ok: true, detail: "" }));
    const result = await selfUpdateToLatest(PKG, {
      moduleUrl: GLOBAL_URL,
      fetchLatest: async () => "0.4.1",
      runInstall
    });
    expect(result).toEqual({ status: "updated", from: "0.4.0", to: "0.4.1" });
    expect(runInstall).toHaveBeenCalledWith("copillm", "0.4.1");
  });

  it("reports failed (without throwing) when the install fails", async () => {
    const result = await selfUpdateToLatest(PKG, {
      moduleUrl: GLOBAL_URL,
      fetchLatest: async () => "0.4.1",
      runInstall: () => ({ ok: false, detail: "EACCES: permission denied" })
    });
    expect(result).toEqual({ status: "failed", from: "0.4.0", to: "0.4.1", detail: "EACCES: permission denied" });
  });

  it("degrades to no-latest when fetchLatest throws", async () => {
    const result = await selfUpdateToLatest(PKG, {
      moduleUrl: GLOBAL_URL,
      fetchLatest: async () => {
        throw new Error("network down");
      },
      runInstall: () => ({ ok: true, detail: "" })
    });
    expect(result).toEqual({ status: "skipped", reason: "no-latest" });
  });

  it("reports failed when runInstall throws", async () => {
    const result = await selfUpdateToLatest(PKG, {
      moduleUrl: GLOBAL_URL,
      fetchLatest: async () => "0.4.1",
      runInstall: () => {
        throw new Error("spawn npm ENOENT");
      }
    });
    expect(result).toMatchObject({ status: "failed", from: "0.4.0", to: "0.4.1" });
  });
});

describe("describeSelfUpdate", () => {
  it("summarizes each actionable outcome and stays silent for not-global", () => {
    expect(describeSelfUpdate({ status: "updated", from: "0.4.0", to: "0.4.1" }, "copillm")).toContain("0.4.0 -> 0.4.1");
    expect(describeSelfUpdate({ status: "up-to-date", version: "0.4.0" }, "copillm")).toContain("up to date");
    expect(describeSelfUpdate({ status: "failed", from: "0.4.0", to: "0.4.1", detail: "x" }, "copillm")).toContain("failed");
    expect(describeSelfUpdate({ status: "skipped", reason: "no-latest" }, "copillm")).toContain("Could not check");
    expect(describeSelfUpdate({ status: "skipped", reason: "not-global" }, "copillm")).toBeNull();
  });
});
