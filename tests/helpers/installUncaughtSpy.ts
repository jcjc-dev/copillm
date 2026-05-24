/**
 * Process-level invariant for resilience tests.
 *
 * Many of the bugs we fixed in `fix(proxy): resilience` manifested as
 * `uncaughtException` / `unhandledRejection` that escaped per-request error
 * handling and killed the daemon. We need every resilience test to actively
 * prove the daemon "would have died without our fix" by counting how many
 * uncaught events the test triggered.
 *
 * Usage:
 *   const spy = installUncaughtSpy();
 *   try { ... } finally { spy.dispose(); }
 *   expect(spy.calls).toEqual([]);
 */
export interface UncaughtSpy {
  readonly calls: ReadonlyArray<{ kind: "uncaughtException" | "unhandledRejection"; reason: unknown }>;
  dispose: () => void;
}

export function installUncaughtSpy(): UncaughtSpy {
  const calls: Array<{ kind: "uncaughtException" | "unhandledRejection"; reason: unknown }> = [];
  const onUncaught = (err: unknown): void => {
    calls.push({ kind: "uncaughtException", reason: err });
  };
  const onUnhandled = (err: unknown): void => {
    calls.push({ kind: "unhandledRejection", reason: err });
  };

  // Prepend so we observe BEFORE the process-level safety net (when installed)
  // — otherwise the safety net would swallow benign errors and we'd see nothing.
  process.prependListener("uncaughtException", onUncaught);
  process.prependListener("unhandledRejection", onUnhandled);

  return {
    get calls(): ReadonlyArray<{ kind: "uncaughtException" | "unhandledRejection"; reason: unknown }> {
      return calls;
    },
    dispose(): void {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
    }
  };
}
