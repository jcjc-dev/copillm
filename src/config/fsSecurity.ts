import fs from "node:fs";
import path from "node:path";

/**
 * Ensure a directory exists with secure (0o700) mode. ONLY chmods when this
 * call had to create the directory — if the dir already existed at entry, we
 * leave its mode untouched. Without this guard, the helper would silently
 * strip group/other bits off the user's `$HOME` the first time native-claude
 * sync writes into it (the renderer emits writes at `$HOME/.claude.json` and
 * `$HOME/.claude/settings.json`, and a naive `chmod 0o700` of the dirname
 * locks out other UIDs on shared-home setups).
 *
 * Callers that own the target path (everything under `~/.copillm`) should use
 * `ensureSecureCopillmDirectory` instead — it tightens the mode even on
 * pre-existing copillm-owned dirs, which is the original intent of this
 * helper for the home tree.
 */
export function ensureSecureDirectory(dirPath: string): void {
  const preExisting = fs.existsSync(dirPath);
  if (!preExisting) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    applyModeIfSupported(dirPath, 0o700);
  }
}

/**
 * Like `ensureSecureDirectory`, but always chmods to 0o700 — even when the
 * directory already existed. Intended for paths copillm owns end to end
 * (`~/.copillm` and its subtree); never use this on a path whose parent could
 * be the user's home directory or any other shared location.
 */
export function ensureSecureCopillmDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  applyModeIfSupported(dirPath, 0o700);
}

export function writeFileSecureAtomic(filePath: string, content: string, mode: number): void {
  ensureSecureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, { mode });
  applyModeIfSupported(tempPath, mode);
  replaceFile(tempPath, filePath);
  applyModeIfSupported(filePath, mode);
}

export interface SecureFileWrite {
  path: string;
  content: string;
  mode: number;
}

/**
 * Atomically write a batch of files with two-phase commit semantics. Phase 1
 * stages every file to a temp path; if any staging write throws, all temps
 * written so far are removed and the error is rethrown, so nothing is
 * committed. Phase 2 renames each staged temp into place — by then all content
 * is safely on disk, so a partial commit is far less likely than a mid-write
 * failure (the failure mode this replaces). Use this when several files must
 * land together (e.g. an agent config fan-out).
 */
export function writeFilesSecureAtomic(writes: ReadonlyArray<SecureFileWrite>): void {
  const staged: Array<{ tempPath: string; finalPath: string; mode: number }> = [];
  try {
    for (const write of writes) {
      ensureSecureDirectory(path.dirname(write.path));
      const tempPath = `${write.path}.tmp-${process.pid}-${Date.now()}-${staged.length}`;
      fs.writeFileSync(tempPath, write.content, { mode: write.mode });
      applyModeIfSupported(tempPath, write.mode);
      staged.push({ tempPath, finalPath: write.path, mode: write.mode });
    }
  } catch (error) {
    for (const item of staged) {
      try {
        fs.unlinkSync(item.tempPath);
      } catch {
        // best effort — nothing was committed, leftover temps are harmless
      }
    }
    throw error;
  }
  for (const item of staged) {
    replaceFile(item.tempPath, item.finalPath);
    applyModeIfSupported(item.finalPath, item.mode);
  }
}

export function applyModeIfSupported(targetPath: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
}

function replaceFile(sourcePath: string, destinationPath: string): void {
  if (process.platform !== "win32") {
    fs.renameSync(sourcePath, destinationPath);
    return;
  }
  if (fs.existsSync(destinationPath)) {
    fs.unlinkSync(destinationPath);
  }
  fs.renameSync(sourcePath, destinationPath);
}
