import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureSecureCopillmDirectory,
  ensureSecureDirectory,
  writeFilesSecureAtomic
} from "../../../src/config/fsSecurity.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-batch-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDebris(): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

describe("writeFilesSecureAtomic", () => {
  it("commits every file in the batch with its content and mode", () => {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "nested", "b.txt");
    writeFilesSecureAtomic([
      { path: a, content: "alpha", mode: 0o600 },
      { path: b, content: "bravo", mode: 0o600 }
    ]);

    expect(fs.readFileSync(a, "utf8")).toBe("alpha");
    expect(fs.readFileSync(b, "utf8")).toBe("bravo");
    expect(tmpDebris()).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(a).mode & 0o777).toBe(0o600);
    }
  });

  it("commits nothing and leaves no temp debris when a staging write fails", () => {
    const committed = path.join(dir, "committed.json");
    // A regular file where a directory is needed makes the second staging write
    // fail with ENOTDIR during phase 1.
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "i am a file");
    const doomed = path.join(blocker, "child.json");

    expect(() =>
      writeFilesSecureAtomic([
        { path: committed, content: "should-roll-back", mode: 0o600 },
        { path: doomed, content: "never", mode: 0o600 }
      ])
    ).toThrow();

    // The first file must not have been committed, and no .tmp- files remain.
    expect(fs.existsSync(committed)).toBe(false);
    expect(tmpDebris()).toEqual([]);
  });

  it("treats an empty batch as a no-op", () => {
    expect(() => writeFilesSecureAtomic([])).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  /**
   * Audit finding (high): the previous `ensureSecureDirectory` would silently
   * `chmod 0o700` ANY directory it was pointed at, even one it didn't create.
   * When the native-claude sync ran, it emitted writes at `$HOME/.claude.json`
   * — dirname = `$HOME` — and the helper would strip group/other read+execute
   * bits off the user's home directory. Pin the new behaviour: when the dir
   * pre-existed, its mode is left alone.
   */
  it("does NOT chmod a pre-existing parent directory (the $HOME-clobber regression)", () => {
    if (process.platform === "win32") return; // POSIX-only invariant
    // Pre-create the parent with a wider mode and assert we don't tighten it.
    const parent = path.join(dir, "preexisting-parent");
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.chmodSync(parent, 0o755);
    const before = fs.statSync(parent).mode & 0o777;
    expect(before).toBe(0o755);

    writeFilesSecureAtomic([
      { path: path.join(parent, "child.json"), content: "x", mode: 0o600 }
    ]);

    const after = fs.statSync(parent).mode & 0o777;
    expect(after).toBe(0o755);
  });

  it("DOES chmod a freshly-created parent directory to 0o700", () => {
    if (process.platform === "win32") return;
    const parent = path.join(dir, "fresh-parent");
    expect(fs.existsSync(parent)).toBe(false);

    writeFilesSecureAtomic([
      { path: path.join(parent, "child.json"), content: "x", mode: 0o600 }
    ]);

    const mode = fs.statSync(parent).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("ensureSecureDirectory vs ensureSecureCopillmDirectory", () => {
  it("ensureSecureDirectory preserves a pre-existing dir's mode", () => {
    if (process.platform === "win32") return;
    const target = path.join(dir, "shared");
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);

    ensureSecureDirectory(target);

    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("ensureSecureCopillmDirectory tightens an existing dir to 0o700", () => {
    if (process.platform === "win32") return;
    const target = path.join(dir, "copillm-owned");
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);

    ensureSecureCopillmDirectory(target);

    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });

  it("both helpers create a missing dir at 0o700", () => {
    if (process.platform === "win32") return;
    const t1 = path.join(dir, "new-shared");
    const t2 = path.join(dir, "new-owned");
    ensureSecureDirectory(t1);
    ensureSecureCopillmDirectory(t2);
    expect(fs.statSync(t1).mode & 0o777).toBe(0o700);
    expect(fs.statSync(t2).mode & 0o777).toBe(0o700);
  });
});
