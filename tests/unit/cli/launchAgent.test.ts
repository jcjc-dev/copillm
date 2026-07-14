import { describe, expect, it } from "vitest";
import { installHint } from "../../../src/cli/launchAgent.js";

describe("installHint", () => {
  it("shows Windows-native Copilot installation guidance", () => {
    const hint = installHint("copilot", "win32");

    expect(hint).toContain("winget install GitHub.Copilot");
    expect(hint).toContain("npm i -g @github/copilot");
    expect(hint).toContain('$env:COPILLM_USE_SYSTEM_AGENT = "1"');
    expect(hint).not.toContain("brew");
  });

  it("shows the current Homebrew cask on macOS", () => {
    const hint = installHint("copilot", "darwin");

    expect(hint).toContain("brew install --cask copilot-cli");
    expect(hint).toContain("export COPILLM_USE_SYSTEM_AGENT=1");
    expect(hint).not.toContain("winget");
  });

  it("does not recommend Homebrew for Codex on Windows", () => {
    const hint = installHint("codex", "win32");

    expect(hint).toContain("npm i -g @openai/codex");
    expect(hint).not.toContain("brew");
  });
});
