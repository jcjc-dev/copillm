import { writeFilesSecureAtomic } from "../config/fsSecurity.js";
import { loadAgentConfig, type LoadResult } from "./load.js";
import {
  planRender,
  type AgentKind,
  type ApplyOptions,
  type ApplyResult,
  type FileWrite
} from "./render.js";
import { backupIfMismatch } from "./markerBlock.js";

/**
 * Load the resolved profile and compute every FileWrite for the target agent
 * BEFORE touching disk. Any validation error throws before a single byte is
 * written, so a botched config never leaves the filesystem half-updated.
 *
 * Returns `{ active: null }` and zero writes when no agent.toml exists
 * anywhere — callers should treat this as a clean no-op.
 */
export function applyAgentConfig(opts: ApplyOptions): ApplyResult {
  if (opts.skip) {
    return { active: null, writes: [], envOverlay: {}, cliArgs: [], notes: [], sources: [], yolo: null };
  }
  const load: LoadResult | null = loadAgentConfig({
    cwd: opts.cwd,
    profileOverride: opts.profileOverride ?? null
  });
  if (!load) {
    return { active: null, writes: [], envOverlay: {}, cliArgs: [], notes: [], sources: [], yolo: null };
  }

  const rendered = planRender(opts, load);

  // Phase 2: write. All validation passed and the renderer produced complete
  // file bodies, so failures here are IO errors. Back up any user-edited
  // targets first, then commit every file as one two-phase atomic batch: each
  // file is staged to a temp path before any is renamed into place, so an IO
  // failure mid-fan-out leaves nothing committed rather than a half-updated set.
  for (const write of rendered.writes) {
    backupIfMismatch(write.path, write.content);
  }
  writeFilesSecureAtomic(rendered.writes);

  return {
    active: load.active,
    writes: rendered.writes,
    envOverlay: rendered.envOverlay,
    cliArgs: rendered.cliArgs,
    notes: rendered.notes,
    sources: load.sources,
    yolo: load.resolved.yolo
  };
}

export function formatApplyNotes(result: ApplyResult, agent: AgentKind): string[] {
  if (result.active === null) return [];
  const lines: string[] = [];
  lines.push(`copillm config: applied profile "${result.active}" to ${agent}`);
  for (const write of result.writes) {
    lines.push(`  → wrote ${write.path} (${write.description})`);
  }
  for (const note of result.notes) {
    lines.push(`  • ${note}`);
  }
  return lines;
}

export type { ApplyOptions, ApplyResult, FileWrite };
