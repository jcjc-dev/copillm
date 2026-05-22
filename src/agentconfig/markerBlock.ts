import fs from "node:fs";
import { AgentConfigError } from "./load.js";

/**
 * Marker-block protocol for files copillm appends into rather than owns
 * outright (AGENTS.md, CLAUDE.md, config.toml extensions).
 *
 * - Lines between `<beginMarker>` and `<endMarker>` are owned by copillm.
 * - On each fan-out, the body inside the markers is replaced with the new
 *   content; the rest of the file is untouched.
 * - If markers are absent, the block is appended at EOF after a blank line.
 * - Markers are formatted as comments using the supplied `commentStart` /
 *   `commentEnd` so the resulting file still parses (HTML comment for .md,
 *   `#` for TOML, `//` for JS-style if ever needed).
 */
export interface MarkerStyle {
  /** Comment opener, e.g. "<!--" or "#" or "//". */
  commentStart: string;
  /** Comment closer, e.g. " -->" for HTML, "" for line comments. */
  commentEnd: string;
}

export const HTML_COMMENT: MarkerStyle = { commentStart: "<!--", commentEnd: " -->" };
export const HASH_COMMENT: MarkerStyle = { commentStart: "#", commentEnd: "" };

const MARKER_ID = "copillm:managed";

function begin(style: MarkerStyle, id: string): string {
  return `${style.commentStart} ${id} begin${style.commentEnd}`;
}
function end(style: MarkerStyle, id: string): string {
  return `${style.commentStart} ${id} end${style.commentEnd}`;
}

export function upsertManagedBlock(
  existing: string,
  body: string,
  style: MarkerStyle = HTML_COMMENT,
  id: string = MARKER_ID
): string {
  const beginLine = begin(style, id);
  const endLine = end(style, id);
  const trimmedBody = body.replace(/^\s+|\s+$/g, "");
  const block = trimmedBody.length > 0 ? `${beginLine}\n${trimmedBody}\n${endLine}` : "";

  const beginIdx = existing.indexOf(beginLine);
  const endIdx = existing.indexOf(endLine);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Replace in place. Strip the existing block + its surrounding newlines so
    // we don't accumulate blank lines on repeated runs.
    const before = existing.slice(0, beginIdx).replace(/\s+$/, "");
    const after = existing.slice(endIdx + endLine.length).replace(/^\s+/, "");
    if (block.length === 0) {
      return ensureTrailingNewline(joinWithBlank(before, after));
    }
    return ensureTrailingNewline(joinWithBlank(before, block, after));
  }
  if (beginIdx !== -1 || endIdx !== -1) {
    throw new AgentConfigError(
      `Found a partial copillm-managed marker block; refusing to write. ` +
        `Restore both "${beginLine}" and "${endLine}" or remove them entirely.`
    );
  }

  if (block.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return `${block}\n`;
  }
  return ensureTrailingNewline(joinWithBlank(existing.replace(/\s+$/, ""), block));
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

function joinWithBlank(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("\n\n");
}

/**
 * If `target` exists and its current content (outside any managed block)
 * differs from `lastWritten`, copy aside to a timestamped `.bak` so the
 * user's edits aren't silently overwritten. Lifted from `src/pi/init.ts`.
 *
 * Best-effort: backup failures don't block the write — preferable to abort
 * the user's launch over a backup error.
 */
export function backupIfMismatch(target: string, newContent: string): string | null {
  let existing: string;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  if (existing === newContent) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${target}.copillm-backup-${stamp}.bak`;
  try {
    fs.copyFileSync(target, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}
