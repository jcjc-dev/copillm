import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Errno codes that indicate a transient failure on Windows when renaming a
 * directory. The two most common offenders are AV/indexer software (Windows
 * Defender, Carbon Black, third-party scanners) holding a brief read handle on
 * a file that was just written, and npm's own post-install lifecycle scripts
 * not having fully closed their handles by the time `npm install` returns.
 *
 * - `EPERM`  — what Node maps `MoveFileExW` -> `ERROR_ACCESS_DENIED` to. The
 *              canonical signature of a Windows handle-held-by-AV failure on
 *              a fresh npm tree.
 * - `EBUSY`  — a file inside the source or destination tree is locked.
 * - `EACCES` — variant of EPERM seen on some Windows configurations.
 * - `ENOTEMPTY` / `EEXIST` — the destination is non-empty mid-rename, usually
 *              because a previous attempt partially populated it.
 */
const TRANSIENT_RENAME_ERROR_CODES = new Set([
  "EPERM",
  "EBUSY",
  "EACCES",
  "ENOTEMPTY",
  "EEXIST"
]);

export interface RenameDirWithRetryOptions {
  /** Backoff delays between successive rename attempts, in milliseconds. */
  retryDelaysMs?: readonly number[];
  /** Logger for per-attempt diagnostics. */
  log?: (line: string) => void;
  /**
   * Sleep implementation. Tests inject a no-op so the retry loop runs
   * synchronously without burning wall-clock time.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Inject a custom `fs.renameSync` (for testing). */
  renameImpl?: (src: string, dst: string) => void;
  /** Inject a custom `fs.cpSync` (for testing). */
  copyImpl?: (src: string, dst: string) => void;
  /** Inject a custom `fs.rmSync` (for testing). */
  removeImpl?: (target: string) => void;
  /** Inject a custom `fs.existsSync` (for testing). */
  existsImpl?: (target: string) => boolean;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000, 2000, 4000];

/**
 * Move a directory from `src` to `dst`, robust against transient Windows
 * failures.
 *
 * The fast path is plain `fs.renameSync` — atomic on POSIX, and *usually*
 * atomic on Windows. When the rename fails with a code from
 * {@link TRANSIENT_RENAME_ERROR_CODES} we back off and retry. If every retry
 * still fails we fall back to a recursive copy-then-delete: slower, not
 * atomic, but works even when AV or another process holds a long-lived handle
 * on a child file inside the staged tree.
 *
 * This helper is intentionally limited in scope to the install path that
 * promotes `<agentRoot>/.staging-…` to `<agentRoot>/<version>` — see
 * {@link ../cli/resolveAgent.ts} call sites. The retry budget is sized for
 * "freshly npm-installed node_modules being scanned by Defender" (a few
 * seconds), not for arbitrary long-held locks.
 */
export async function renameDirWithRetry(
  src: string,
  dst: string,
  opts: RenameDirWithRetryOptions = {}
): Promise<void> {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const log = opts.log ?? (() => undefined);
  const sleepFn = opts.sleepImpl ?? sleep;
  const renameFn = opts.renameImpl ?? fs.renameSync.bind(fs);
  const copyFn = opts.copyImpl ?? ((s, d) => fs.cpSync(s, d, { recursive: true, force: true }));
  const removeFn = opts.removeImpl ?? ((t) => fs.rmSync(t, { recursive: true, force: true }));
  const existsFn = opts.existsImpl ?? fs.existsSync.bind(fs);

  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      renameFn(src, dst);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code ?? "";
      if (!TRANSIENT_RENAME_ERROR_CODES.has(code)) {
        throw error;
      }
      if (attempt === delays.length) break;
      const delayMs = delays[attempt];
      log(
        `\u2192 rename ${src} -> ${dst} failed with ${code}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${delays.length})`
      );
      await sleepFn(delayMs);
    }
  }

  const lastCode = (lastError as { code?: string }).code ?? "unknown";
  log(`\u2192 rename still failing after ${delays.length} retries (${lastCode}); falling back to copy + delete`);
  try {
    if (existsFn(dst)) {
      removeFn(dst);
    }
    copyFn(src, dst);
    removeFn(src);
  } catch (copyError) {
    const lastMsg = lastError instanceof Error ? lastError.message : String(lastError);
    const copyMsg = copyError instanceof Error ? copyError.message : String(copyError);
    throw new Error(
      `Failed to move ${src} -> ${dst}: ${lastMsg} (copy+delete fallback also failed: ${copyMsg})`
    );
  }
}
