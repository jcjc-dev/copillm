import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renameDirWithRetry } from "../../../src/cli/renameDirWithRetry.js";

// Helper: build an Error matching the shape Node throws from fs.renameSync
// failures (so `error.code` is set just like the real thing).
function makeFsError(code: string, syscall: string = "rename"): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated failure, ${syscall}`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  return err;
}

describe("renameDirWithRetry", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs.length = 0;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("succeeds on the first attempt when rename works", async () => {
    let calls = 0;
    await renameDirWithRetry("/from", "/to", {
      renameImpl: () => {
        calls += 1;
      },
      sleepImpl: async () => undefined
    });
    expect(calls).toBe(1);
  });

  it("retries transient EPERM failures and eventually succeeds", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    await renameDirWithRetry("/from", "/to", {
      retryDelaysMs: [10, 20, 40],
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      },
      renameImpl: () => {
        calls += 1;
        if (calls < 3) throw makeFsError("EPERM");
      }
    });
    expect(calls).toBe(3);
    expect(sleepCalls).toEqual([10, 20]);
  });

  it("retries EBUSY, EACCES, ENOTEMPTY, and EEXIST too", async () => {
    for (const code of ["EBUSY", "EACCES", "ENOTEMPTY", "EEXIST"]) {
      let calls = 0;
      await renameDirWithRetry("/from", "/to", {
        retryDelaysMs: [1],
        sleepImpl: async () => undefined,
        renameImpl: () => {
          calls += 1;
          if (calls === 1) throw makeFsError(code);
        }
      });
      expect(calls, `code=${code}`).toBe(2);
    }
  });

  it("does not retry on non-transient errors (e.g. ENOENT)", async () => {
    let calls = 0;
    await expect(
      renameDirWithRetry("/from", "/to", {
        sleepImpl: async () => undefined,
        renameImpl: () => {
          calls += 1;
          throw makeFsError("ENOENT");
        }
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("falls back to copy + delete when rename keeps failing", async () => {
    let renameCalls = 0;
    let copyCalls = 0;
    const removed: string[] = [];

    await renameDirWithRetry("/from", "/to", {
      retryDelaysMs: [1, 1, 1],
      sleepImpl: async () => undefined,
      renameImpl: () => {
        renameCalls += 1;
        throw makeFsError("EPERM");
      },
      copyImpl: () => {
        copyCalls += 1;
      },
      removeImpl: (t) => {
        removed.push(t);
      },
      existsImpl: () => true
    });

    expect(renameCalls).toBe(4); // 1 initial + 3 retries
    expect(copyCalls).toBe(1);
    // First we remove the (existing) destination, then we remove the source.
    expect(removed).toEqual(["/to", "/from"]);
  });

  it("does not pre-remove destination when it does not exist", async () => {
    const removed: string[] = [];
    await renameDirWithRetry("/from", "/to", {
      retryDelaysMs: [1],
      sleepImpl: async () => undefined,
      renameImpl: () => {
        throw makeFsError("EPERM");
      },
      copyImpl: () => undefined,
      removeImpl: (t) => {
        removed.push(t);
      },
      existsImpl: () => false
    });
    // Only the source is removed (the destination did not exist).
    expect(removed).toEqual(["/from"]);
  });

  it("wraps the original error message when the copy fallback also fails", async () => {
    await expect(
      renameDirWithRetry("/from", "/to", {
        retryDelaysMs: [1],
        sleepImpl: async () => undefined,
        renameImpl: () => {
          throw makeFsError("EPERM");
        },
        copyImpl: () => {
          throw new Error("copy disk full");
        },
        removeImpl: () => undefined,
        existsImpl: () => false
      })
    ).rejects.toThrow(/EPERM[\s\S]*copy disk full/);
  });

  it("works against the real filesystem with a real directory tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-renametest-"));
    tempDirs.push(root);
    const src = path.join(root, "src");
    const dst = path.join(root, "dst");
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(src, "nested"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.txt"), "hello");
    fs.writeFileSync(path.join(src, "nested", "b.txt"), "world");

    await renameDirWithRetry(src, dst);

    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(path.join(dst, "a.txt"), "utf8")).toBe("hello");
    expect(fs.readFileSync(path.join(dst, "nested", "b.txt"), "utf8")).toBe("world");
  });

  it("logs per-attempt diagnostics including the error code", async () => {
    const logs: string[] = [];
    let calls = 0;
    await renameDirWithRetry("/src/path", "/dst/path", {
      retryDelaysMs: [5, 10],
      sleepImpl: async () => undefined,
      log: (line) => logs.push(line),
      renameImpl: () => {
        calls += 1;
        if (calls < 3) throw makeFsError("EPERM");
      }
    });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/EPERM/);
    expect(logs[0]).toMatch(/attempt 1\/2/);
    expect(logs[1]).toMatch(/attempt 2\/2/);
  });
});
