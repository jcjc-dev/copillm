/**
 * Pure decision logic for `copillm restart`.
 *
 * `restart` brings the daemon back up on the settings it is *actually* running
 * on — its port and its debug mode — without persisting anything to disk. Port
 * comes straight from the live lock; debug mode is detected at runtime by
 * probing `/_debug` (only mounted when debug is on). The home/dev scope is
 * inherent: the lock is per-`COPILLM_HOME`, so `copillm --dev restart` only
 * ever touches the dev daemon.
 *
 * Keeping the decision pure (no I/O) makes every branch — running, stale,
 * missing, debug-detected, debug-forced — trivially unit-testable.
 */

export type DaemonLockState =
  | { state: "running"; pid: number; port: number }
  | { state: "stale" }
  | { state: "missing" };

export interface RestartDecision {
  /**
   * `restart` when a live daemon was found and will be stopped first;
   * `start_fresh` when nothing was running (or only a stale lock remained), in
   * which case we just bring a daemon up with default settings.
   */
  action: "restart" | "start_fresh";
  /** Pid of the daemon to stop, or null when nothing live was running. */
  previousPid: number | null;
  /** Port to rebind the restarted daemon onto, or null to use the configured default. */
  forcePort: number | null;
  /** Whether a stale lock needs to be released before starting fresh. */
  clearStaleLock: boolean;
  /** Effective debug mode for the restarted daemon. */
  debug: boolean;
}

export function resolveRestartDecision(input: {
  lock: DaemonLockState;
  detectedDebug: boolean;
  forceDebug: boolean;
}): RestartDecision {
  const { lock, detectedDebug, forceDebug } = input;

  if (lock.state === "running") {
    return {
      action: "restart",
      previousPid: lock.pid,
      forcePort: lock.port,
      clearStaleLock: false,
      // `--debug` forces it on; otherwise preserve whatever the running daemon had.
      debug: forceDebug || detectedDebug
    };
  }

  return {
    action: "start_fresh",
    previousPid: null,
    forcePort: null,
    clearStaleLock: lock.state === "stale",
    // Nothing was running, so there is no debug state to preserve — only the
    // explicit `--debug` request can turn it on.
    debug: forceDebug
  };
}
