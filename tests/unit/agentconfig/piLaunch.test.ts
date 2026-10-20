import { describe, expect, it } from "vitest";
import { applyPiModelDefault } from "../../../src/agentconfig/piLaunch.js";

describe("Pi launch model default", () => {
  it("adds the agent.toml model when no model was explicitly selected", () => {
    expect(applyPiModelDefault(["--continue"], "gpt-6-luna")).toEqual([
      "--continue",
      "--model",
      "gpt-6-luna"
    ]);
  });

  it("leaves an explicit --model selection untouched", () => {
    expect(applyPiModelDefault(["--model", "custom-model"], "gpt-6-luna")).toEqual([
      "--model",
      "custom-model"
    ]);
    expect(applyPiModelDefault(["--model=custom-model"], "gpt-6-luna")).toEqual([
      "--model=custom-model"
    ]);
  });

  it("does not change arguments when agent.toml has no model setting", () => {
    expect(applyPiModelDefault(["--continue"], undefined)).toEqual(["--continue"]);
  });
});
