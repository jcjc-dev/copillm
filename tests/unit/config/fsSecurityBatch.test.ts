import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFilesSecureAtomic } from "../../../src/config/fsSecurity.js";

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
});
