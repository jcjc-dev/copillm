import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for the bug where program.version was hardcoded to "0.1.0"
// and silently drifted from package.json across releases (see fix in
// src/cli.ts that uses createRequire(import.meta.url) to resolve the version
// at runtime). If anyone reverts to a string literal, this test fails.
describe("copillm --version", () => {
  it("matches the version field in package.json", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    if (!fs.existsSync(cliPath)) {
      throw new Error(`CLI artifact missing at ${cliPath} — globalSetup did not run.`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };

    const result = spawnSync(process.execPath, [cliPath, "--version"], {
      encoding: "utf8",
      timeout: 10_000
    });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});
