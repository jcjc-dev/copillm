import { describe, expect, it } from "vitest";
import { applyPiModelDefault, applyPiThinkingDefault } from "../../../src/agentconfig/piLaunch.js";

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

describe("Pi launch thinking default", () => {
  it("adds the configured level when no thinking option was explicitly selected", () => {
    expect(applyPiThinkingDefault(["--continue", "--model", "gpt-6-luna"], "xhigh")).toEqual([
      "--continue",
      "--model",
      "gpt-6-luna",
      "--thinking",
      "xhigh"
    ]);
  });

  it("does not override an explicit thinking option", () => {
    expect(applyPiThinkingDefault(["--thinking", "medium"], "xhigh")).toEqual([
      "--thinking",
      "medium"
    ]);
    expect(applyPiThinkingDefault(["--thinking=xhigh"], "medium")).toEqual(["--thinking=xhigh"]);
  });

  it("does not override a thinking level attached to an explicit model", () => {
    expect(applyPiThinkingDefault(["--model", "gpt-6-luna:high"], "xhigh")).toEqual([
      "--model",
      "gpt-6-luna:high"
    ]);
    expect(applyPiThinkingDefault(["--model=gpt-6-luna:max"], "xhigh")).toEqual([
      "--model=gpt-6-luna:max"
    ]);
  });

  it("leaves args unchanged when no thinking default is configured", () => {
    expect(applyPiThinkingDefault(["--continue"], undefined)).toEqual(["--continue"]);
  });
});
