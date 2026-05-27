import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard: when the user runs `copillm codex|claude|pi` without
// being logged in, the launcher must surface a clear "Not authenticated"
// message instead of the misleading "Auto-start of copillm daemon timed
// out" error that used to happen because the detached daemon would die
// silently on missing credentials and the launcher only saw the readiness
// timeout.

const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

const AGENTS: readonly ("codex" | "claude" | "pi")[] = ["codex", "claude", "pi"];

describe("agent launcher when not authenticated", () => {
  for (const agent of AGENTS) {
    it(`copillm ${agent} fails fast with a login hint`, () => {
      if (process.platform === "win32") return;
      if (!fs.existsSync(cliPath)) {
        throw new Error(`CLI artifact missing at ${cliPath}.`);
      }

      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), `copillm-${agent}-unauth-`));
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          COPILLM_HOME: emptyHome,
          COPILLM_ALLOW_PLAINTEXT_CREDENTIALS: "1",
          COPILLM_FORCE_SESSION_BACKEND: "1"
        };

        const start = Date.now();
        const result = spawnSync(
          process.execPath,
          [cliPath, agent, "--copillm-no-config"],
          { env, encoding: "utf8", timeout: 15_000 }
        );
        const elapsedMs = Date.now() - start;

        // Must NOT surface the old generic timeout message.
        expect(result.stderr).not.toMatch(/Auto-start of copillm daemon timed out/);
        // Must surface an actionable login hint.
        expect(result.stderr).toMatch(/Not authenticated/);
        expect(result.stderr).toMatch(/copillm auth login/);
        // And it must fail fast — well under the 10s daemon-readiness timeout.
        expect(elapsedMs).toBeLessThan(5000);
        expect(result.status).not.toBe(0);
      } finally {
        fs.rmSync(emptyHome, { recursive: true, force: true });
      }
    });
  }
});
