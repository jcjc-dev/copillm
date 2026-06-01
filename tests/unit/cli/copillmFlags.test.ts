import { describe, expect, it } from "vitest";
import { processCopillmArgs } from "../../../src/cli/copillmFlags.js";

describe("processCopillmArgs", () => {
  it("extracts a copillm flag that appears AFTER an agent flag (the original bug)", () => {
    const { opts, forwarded } = processCopillmArgs([
      "--dangerously-skip-permissions",
      "--copillm-profile",
      "work"
    ]);
    expect(opts.copillmProfile).toBe("work");
    expect(forwarded).toEqual(["--dangerously-skip-permissions"]);
  });

  it("extracts copillm flags that appear BEFORE agent flags (today's working order)", () => {
    const { opts, forwarded } = processCopillmArgs([
      "--copillm-profile",
      "work",
      "--dangerously-skip-permissions"
    ]);
    expect(opts.copillmProfile).toBe("work");
    expect(forwarded).toEqual(["--dangerously-skip-permissions"]);
  });

  it("accepts the --flag=value form for value flags", () => {
    const { opts, forwarded } = processCopillmArgs(["--copillm-profile=work"]);
    expect(opts.copillmProfile).toBe("work");
    expect(forwarded).toEqual([]);
  });

  it("sets boolean flags true and removes them from forwarded", () => {
    const { opts, forwarded } = processCopillmArgs([
      "--copillm-debug",
      "--copillm-no-config",
      "--yolo",
      "chat"
    ]);
    expect(opts.copillmDebug).toBe(true);
    expect(opts.copillmNoConfig).toBe(true);
    expect(opts.yolo).toBe(true);
    expect(forwarded).toEqual(["chat"]);
  });

  it("extracts copillm flags even after a -- separator, but forwards -- itself", () => {
    const { opts, forwarded } = processCopillmArgs([
      "run",
      "--",
      "--copillm-profile",
      "work",
      "--yolo"
    ]);
    expect(opts.copillmProfile).toBe("work");
    expect(opts.yolo).toBe(true);
    expect(forwarded).toEqual(["run", "--"]);
  });

  it("throws a clear error when a value flag is missing its value", () => {
    expect(() => processCopillmArgs(["--copillm-profile"])).toThrow(
      "--copillm-profile requires a value"
    );
  });

  it("last-wins when a flag is repeated", () => {
    const { opts } = processCopillmArgs([
      "--copillm-profile",
      "first",
      "--copillm-profile",
      "second"
    ]);
    expect(opts.copillmProfile).toBe("second");
  });

  it("forwards pure agent args untouched when no copillm flags are present", () => {
    const input = ["-p", "hello", "--model", "gpt-5", "chat"];
    const { opts, forwarded } = processCopillmArgs(input);
    expect(opts).toEqual({});
    expect(forwarded).toEqual(input);
  });

  it("handles --copillm-use pinning the package version", () => {
    const { opts, forwarded } = processCopillmArgs([
      "--copillm-use",
      "@openai/codex@1.4.7",
      "chat"
    ]);
    expect(opts.copillmUse).toBe("@openai/codex@1.4.7");
    expect(forwarded).toEqual(["chat"]);
  });

  it("does not mutate the input array", () => {
    const input = ["--copillm-profile", "work", "chat"];
    const copy = [...input];
    processCopillmArgs(input);
    expect(input).toEqual(copy);
  });
});
