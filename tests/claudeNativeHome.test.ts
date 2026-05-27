import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderClaude } from "../src/agentconfig/render.js";

// Regression test for the native Claude sync home resolution fix: writes must
// land under $HOME when set (so test sandboxes, container shells, and users
// who override HOME aren't punished by os.homedir() ignoring the env var).
describe("renderClaude — native sync home resolution", () => {
  let tmpHome: string;
  let tmpCopillmHome: string;
  let savedHome: string | undefined;
  let savedCopillm: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-claude-home-"));
    tmpCopillmHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-claude-copillm-"));
    savedHome = process.env.HOME;
    savedCopillm = process.env.COPILLM_HOME;
    process.env.HOME = tmpHome;
    process.env.COPILLM_HOME = tmpCopillmHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedCopillm === undefined) delete process.env.COPILLM_HOME;
    else process.env.COPILLM_HOME = savedCopillm;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCopillmHome, { recursive: true, force: true });
  });

  it("writes ~/.claude.json and ~/.claude/settings.json under $HOME (not os.homedir())", () => {
    const result = renderClaude({
      cwd: tmpCopillmHome,
      nativeSync: true,
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4141/anthropic" },
      resolved: {
        instructions: null,
        mcpServers: {
          "copillm-github": {
            type: "http",
            url: "https://example.com/mcp"
          } as never
        },
        yolo: null,
        reserved: { skills: {}, agents: {}, hooks: {}, permissions: {} }
      } as never
    });

    const paths = result.writes.map((w) => w.path);
    expect(paths).toContain(path.join(tmpHome, ".claude.json"));
    expect(paths).toContain(path.join(tmpHome, ".claude", "settings.json"));
    // Sanity: no write escaped to the real user's home directory.
    const realHome = os.homedir();
    if (realHome && realHome !== tmpHome) {
      for (const p of paths) {
        expect(p.startsWith(realHome + path.sep)).toBe(false);
      }
    }
  });
});
