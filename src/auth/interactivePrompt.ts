// Minimal interactive prompt helpers for the CLI. Reads stdin in raw mode
// when attached to a TTY; falls back to line mode otherwise. Always restores
// stdin state on completion (success, error, or abort) via try/finally.
//
// These helpers are intended for very short interactions (single-keypress
// y/n confirmation, single-keypress menu choice). Anything longer should use
// readline directly.

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

interface PromptStream {
  isTTY: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: string): unknown;
  once(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
}

function getStdin(): PromptStream {
  // Cast through unknown — node's stream types are wider than what we need.
  return process.stdin as unknown as PromptStream;
}

function getStdout(): { write(chunk: string): unknown } {
  return process.stdout as unknown as { write(chunk: string): unknown };
}

async function readSingleKey(): Promise<string> {
  const stdin = getStdin();
  if (!stdin.isTTY) {
    throw new Error("Cannot read interactive input: stdin is not a TTY.");
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const onData = (chunk: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      stdin.off("data", onData);
      try {
        stdin.setRawMode?.(false);
        stdin.pause();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve(chunk);
    };
    try {
      stdin.setEncoding("utf8");
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.once("data", onData);
    } catch (error) {
      stdin.off("data", onData);
      try {
        stdin.setRawMode?.(false);
        stdin.pause();
      } catch {
        // best-effort restoration
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function isAbortKey(key: string): boolean {
  return key === CTRL_C || key === CTRL_D;
}

/**
 * Prompt the user with a y/n question. Returns true for y/Y, false for n/N.
 * Throws if the user sends Ctrl+C / Ctrl+D, or if stdin is not a TTY.
 */
export async function confirm(message: string): Promise<boolean> {
  const stdout = getStdout();
  stdout.write(`${message} [y/N] `);
  let answer = "";
  try {
    answer = await readSingleKey();
  } catch (error) {
    stdout.write("\n");
    throw error;
  }
  const first = answer.charAt(0);
  if (isAbortKey(first)) {
    stdout.write("\n");
    throw new Error("Interactive prompt aborted by user.");
  }
  const lowered = first.toLowerCase();
  const isYes = lowered === "y";
  stdout.write(`${isYes ? "y" : "n"}\n`);
  return isYes;
}

export interface ChoiceOption<T> {
  key: string;
  label: string;
  value: T;
}

/**
 * Prompt the user with a single-keypress menu. Each option has a one-character
 * `key` (case-insensitive match) shown in parens before its label.
 *
 * Throws if the user sends Ctrl+C / Ctrl+D, or if stdin is not a TTY. Retries
 * silently on unrecognised keypresses (up to `maxAttempts` times).
 */
export async function choose<T>(
  message: string,
  options: ReadonlyArray<ChoiceOption<T>>,
  maxAttempts = 5
): Promise<T> {
  if (options.length === 0) {
    throw new Error("choose() requires at least one option.");
  }
  const seenKeys = new Set<string>();
  for (const opt of options) {
    if (opt.key.length !== 1) {
      throw new Error(`choose() option keys must be a single character (got '${opt.key}').`);
    }
    const lowered = opt.key.toLowerCase();
    if (seenKeys.has(lowered)) {
      throw new Error(`choose() option keys must be unique (duplicate '${opt.key}').`);
    }
    seenKeys.add(lowered);
  }

  const stdout = getStdout();
  const rendered = options.map((opt) => `(${opt.key.toLowerCase()})${opt.label}`).join(" / ");
  stdout.write(`${message}\n  ${rendered}: `);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let key = "";
    try {
      key = await readSingleKey();
    } catch (error) {
      stdout.write("\n");
      throw error;
    }
    const first = key.charAt(0);
    if (isAbortKey(first)) {
      stdout.write("\n");
      throw new Error("Interactive prompt aborted by user.");
    }
    const match = options.find((opt) => opt.key.toLowerCase() === first.toLowerCase());
    if (match) {
      stdout.write(`${match.key.toLowerCase()}  (${match.label})\n`);
      return match.value;
    }
    stdout.write("\n  invalid choice — try again: ");
  }

  stdout.write("\n");
  throw new Error(`No valid choice after ${maxAttempts} attempts.`);
}
