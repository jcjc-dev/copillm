import { describe, expect, it } from "vitest";
import { mapCopilotModelToCodex } from "../src/server/codexSchema.js";
import type { CopilotModel } from "../src/models/discovery.js";

function model(id: string, supports: Record<string, unknown> = {}): CopilotModel {
  return {
    id,
    vendor: "TestVendor",
    name: id,
    model_picker_enabled: true,
    capabilities: {
      supports: { parallel_tool_calls: true, ...supports },
      limits: { max_context_window_tokens: 128_000 }
    }
  };
}

describe("mapCopilotModelToCodex vision derivation", () => {
  it("advertises image modality when upstream reports vision support", () => {
    const out = mapCopilotModelToCodex(model("vision-yes", { vision: true }));
    expect(out.input_modalities).toEqual(["text", "image"]);
    expect(out.supports_image_detail_original).toBe(true);
  });

  it("hides image modality when upstream omits vision support", () => {
    const out = mapCopilotModelToCodex(model("vision-no"));
    expect(out.input_modalities).toEqual(["text"]);
    expect(out.supports_image_detail_original).toBe(false);
  });

  it("hides image modality when vision flag is explicitly false", () => {
    const out = mapCopilotModelToCodex(model("vision-false", { vision: false }));
    expect(out.input_modalities).toEqual(["text"]);
    expect(out.supports_image_detail_original).toBe(false);
  });

  it("treats non-boolean vision values as no support", () => {
    const out = mapCopilotModelToCodex(model("vision-weird", { vision: "yes" as unknown as boolean }));
    expect(out.input_modalities).toEqual(["text"]);
    expect(out.supports_image_detail_original).toBe(false);
  });
});
