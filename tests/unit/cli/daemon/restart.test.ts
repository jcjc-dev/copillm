import { describe, expect, it } from "vitest";

import { resolveRestartDecision } from "../../../../src/cli/daemon/restart.js";

/**
 * `resolveRestartDecision` is the pure core of `copillm restart`: given the
 * live lock state, the debug mode detected on the running daemon, and whether
 * `--debug` was passed, it decides what the restarted daemon should look like.
 * Port and debug are preserved from the *running* daemon; nothing is persisted.
 */
describe("resolveRestartDecision", () => {
  it("restarts a running daemon on its current port and preserves detected debug", () => {
    const decision = resolveRestartDecision({
      lock: { state: "running", pid: 4321, port: 4150 },
      detectedDebug: true,
      forceDebug: false
    });
    expect(decision).toEqual({
      action: "restart",
      previousPid: 4321,
      forcePort: 4150,
      clearStaleLock: false,
      debug: true
    });
  });

  it("keeps debug off when the running daemon had none and --debug was not passed", () => {
    const decision = resolveRestartDecision({
      lock: { state: "running", pid: 10, port: 4141 },
      detectedDebug: false,
      forceDebug: false
    });
    expect(decision.action).toBe("restart");
    expect(decision.forcePort).toBe(4141);
    expect(decision.debug).toBe(false);
  });

  it("forces debug on when --debug is passed even if the daemon had none", () => {
    const decision = resolveRestartDecision({
      lock: { state: "running", pid: 10, port: 4141 },
      detectedDebug: false,
      forceDebug: true
    });
    expect(decision.debug).toBe(true);
  });

  it("starts fresh and clears the stale lock when only a stale lock remains", () => {
    const decision = resolveRestartDecision({
      lock: { state: "stale" },
      detectedDebug: false,
      forceDebug: false
    });
    expect(decision).toEqual({
      action: "start_fresh",
      previousPid: null,
      forcePort: null,
      clearStaleLock: true,
      debug: false
    });
  });

  it("starts fresh without a stale-lock clear when nothing is running", () => {
    const decision = resolveRestartDecision({
      lock: { state: "missing" },
      detectedDebug: false,
      forceDebug: true
    });
    expect(decision).toEqual({
      action: "start_fresh",
      previousPid: null,
      forcePort: null,
      clearStaleLock: false,
      debug: true
    });
  });
});
