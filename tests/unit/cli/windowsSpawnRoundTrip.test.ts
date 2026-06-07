// Sanity test: real cmd.exe round-trip on Windows.
// Verifies the escape pipeline by spawning an actual .cmd shim with
// pathological arguments and checking that the underlying program sees them
// byte-for-byte intact.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWindowsCmdInvocation } from "../../../src/cli/windowsSpawn.js";

const isWindows = process.platform === "win32";

describe.runIf(isWindows)("buildWindowsCmdInvocation — real cmd.exe round-trip", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-spawn-test-"));

  // Create a minimal npm-style shim: a .cmd that calls node with our printer
  // script, passing %* through. This mirrors the structure of
  // node_modules/.bin/<tool>.cmd that we hit in production.
  const printerJs = path.join(tmp, "printer.js");
  fs.writeFileSync(
    printerJs,
    `process.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
    "utf8"
  );
  const shimCmd = path.join(tmp, "printer.cmd");
  fs.writeFileSync(
    shimCmd,
    `@echo off\r\nnode "${printerJs}" %*\r\n`,
    "utf8"
  );

  const cases: Array<{ label: string; args: string[] }> = [
    { label: "plain word", args: ["hello"] },
    { label: "spaces in value", args: ["hello world", "foo bar"] },
    { label: "ampersand metachar", args: ["a&b", "c&&d"] },
    { label: "pipe and redirect", args: ["a|b", "c>d", "<e"] },
    { label: "quoted phrase", args: ['say "hi"', "it's fine"] },
    { label: "parentheses", args: ["(grouped)"] },
    { label: "trailing backslash", args: ["C:\\dir\\"] },
    { label: "percent and bang", args: ["100%", "!banged!"] },
    { label: "mixed gnarly", args: ["--prompt", "ls & rm -rf foo | echo $HOME"] },
    { label: "empty string", args: [""] }
  ];

  for (const { label, args } of cases) {
    it(`survives a real cmd.exe → .cmd shim round-trip: ${label}`, () => {
      const { command, args: cmdArgs } = buildWindowsCmdInvocation(shimCmd, args);
      const result = spawnSync(command, cmdArgs, {
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      expect(result.status).toBe(0);
      const stdout = result.stdout.toString("utf8");
      expect(JSON.parse(stdout)).toEqual(args);
    });
  }

  // Smoke-check: also verify that Node itself is reachable from the test
  // environment so a failure above implies escape breakage, not toolchain.
  it("node is on PATH", () => {
    const out = execFileSync("node", ["-e", "process.stdout.write('ok')"]).toString();
    expect(out).toBe("ok");
  });
});
