import { describe, expect, it } from "vitest";
import { accountTypeFromCopilotApiUrl } from "../../../src/config/upstream.js";

describe("accountTypeFromCopilotApiUrl", () => {
  it("maps the authoritative Copilot API hosts", () => {
    expect(accountTypeFromCopilotApiUrl("https://api.githubcopilot.com")).toBe("individual");
    expect(accountTypeFromCopilotApiUrl("https://api.business.githubcopilot.com/")).toBe("business");
    expect(accountTypeFromCopilotApiUrl("https://api.enterprise.githubcopilot.com")).toBe("enterprise");
  });

  it("rejects unknown or unsafe endpoint values", () => {
    expect(accountTypeFromCopilotApiUrl("http://api.enterprise.githubcopilot.com")).toBeNull();
    expect(accountTypeFromCopilotApiUrl("https://example.com")).toBeNull();
    expect(accountTypeFromCopilotApiUrl("https://api.githubcopilot.com/models")).toBeNull();
    expect(accountTypeFromCopilotApiUrl("https://api.githubcopilot.com.evil.example")).toBeNull();
    expect(accountTypeFromCopilotApiUrl("https://evil.example@api.githubcopilot.com")).toBeNull();
    expect(accountTypeFromCopilotApiUrl("not a URL")).toBeNull();
    expect(accountTypeFromCopilotApiUrl(undefined)).toBeNull();
  });
});
