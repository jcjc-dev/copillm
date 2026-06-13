import os from "node:os";
import path from "node:path";

/**
 * Dev-mode isolation.
 *
 * Running a locally-built copillm against the SAME `~/.copillm` home and port as
 * a globally-installed production daemon is a footgun: `stop` reads
 * `~/.copillm/copillm.pid` and would kill the production daemon, and `start`
 * sees the production lock and reports "already running" instead of launching
 * your dev code.
 *
 * Dev mode redirects the runtime onto a separate `COPILLM_HOME` (and a distinct
 * default port) so a dev daemon and a production daemon can run side by side
 * without ever touching each other's lock, config, model cache, or port. This
 * is the mechanism that lets you develop copillm WHILE using copillm.
 *
 * The override is implemented by setting the same `COPILLM_HOME` / `COPILLM_PORT`
 * env vars the rest of the codebase already reads (see `src/config/home.ts` and
 * `src/config/config.ts`). Because detached daemons and spawned agents inherit
 * `process.env`, the isolation propagates to every child process for free.
 *
 * Activated by the global `--dev` flag or by exporting `COPILLM_DEV=1`. The
 * concrete locations are overridable via `COPILLM_DEV_HOME` / `COPILLM_DEV_PORT`.
 * An explicitly-set `COPILLM_HOME` / `COPILLM_PORT` always wins — dev mode never
 * clobbers a home or port the user pinned on purpose.
 */

export const DEV_HOME_DIRNAME = ".copillm-dev";
export const DEFAULT_DEV_PORT = 4142;

export interface DevModeState {
  /** Whether dev mode is active for this invocation. */
  active: boolean;
  /** The resolved COPILLM_HOME when active, else null. */
  home: null | string;
  /** The resolved COPILLM_PORT when active, else null. */
  port: null | string;
}

// Set once dev mode has been applied for this process, so command surfaces
// (start banner, status) can annotate output without re-deriving intent.
let devModeActive = false;

/** Whether dev mode has been applied to this process. */
export function isDevModeActive(): boolean {
  return devModeActive;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function nonEmptyEnv(value: string | undefined): null | string {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether dev mode was requested, via the `--dev` flag (passed in) or the
 * `COPILLM_DEV` env var.
 */
export function isDevModeRequested(flag?: boolean): boolean {
  return Boolean(flag) || isTruthyEnv(process.env.COPILLM_DEV);
}

/** The isolated dev home: `COPILLM_DEV_HOME` if set, else `~/.copillm-dev`. */
export function resolveDevHome(): string {
  const override = nonEmptyEnv(process.env.COPILLM_DEV_HOME);
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), DEV_HOME_DIRNAME);
}

/** The isolated dev port: `COPILLM_DEV_PORT` if set, else `4142`. */
export function resolveDevPort(): string {
  const override = nonEmptyEnv(process.env.COPILLM_DEV_PORT);
  if (override) {
    return override;
  }
  return String(DEFAULT_DEV_PORT);
}

/**
 * Apply dev-mode isolation to `process.env` when requested. Idempotent and
 * safe to call multiple times.
 *
 * - No-op when dev mode is not requested.
 * - Sets `COPILLM_HOME` to the dev home ONLY when it is not already set, so an
 *   explicit `COPILLM_HOME` always wins.
 * - Sets `COPILLM_PORT` to the dev port ONLY when it is not already set, so an
 *   explicit `COPILLM_PORT` always wins.
 */
export function applyDevModeEnv(flag?: boolean): DevModeState {
  if (!isDevModeRequested(flag)) {
    return { active: false, home: null, port: null };
  }

  if (!nonEmptyEnv(process.env.COPILLM_HOME)) {
    process.env.COPILLM_HOME = resolveDevHome();
  }
  if (!nonEmptyEnv(process.env.COPILLM_PORT)) {
    process.env.COPILLM_PORT = resolveDevPort();
  }

  devModeActive = true;
  return {
    active: true,
    home: process.env.COPILLM_HOME ?? null,
    port: process.env.COPILLM_PORT ?? null
  };
}
