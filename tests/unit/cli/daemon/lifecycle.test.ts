import { describe, expect, it } from "vitest";

import { formatUptime } from "../../../../src/cli/daemon/lifecycle.js";

/**
 * `formatUptime` renders an uptime in seconds as a compact
 * `Xd Yh Zm Zs` string for the `copillm status` human output. Leading
 * zero-value units are dropped; sub-minute / zero durations fall back to a
 * seconds component so the result is never empty.
 */
describe("formatUptime", () => {
  it("renders zero as 0s", () => {
    expect(formatUptime(0)).toBe("0s");
  });

  it("renders sub-minute durations in seconds only", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("drops a zero seconds component once a larger unit is present", () => {
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(3_600)).toBe("1h");
    expect(formatUptime(86_400)).toBe("1d");
  });

  it("includes seconds when non-zero alongside larger units", () => {
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(3_661)).toBe("1h 1m 1s");
  });

  it("renders a full day/hour/minute/second breakdown", () => {
    // 2d 3h 15m 9s = 2*86400 + 3*3600 + 15*60 + 9 = 184_509
    expect(formatUptime(184_509)).toBe("2d 3h 15m 9s");
  });

  it("omits intermediate zero units", () => {
    // exactly 2 days, no hours/minutes/seconds
    expect(formatUptime(2 * 86_400)).toBe("2d");
    // 1 day + 5 minutes, no hours
    expect(formatUptime(86_400 + 5 * 60)).toBe("1d 5m");
  });

  it("floors fractional seconds", () => {
    expect(formatUptime(59.9)).toBe("59s");
  });

  it("clamps negative and non-finite inputs to 0s", () => {
    expect(formatUptime(-5)).toBe("0s");
    expect(formatUptime(Number.NaN)).toBe("0s");
    expect(formatUptime(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});
