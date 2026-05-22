#!/usr/bin/env tsx
/**
 * Probe: dump per-model vision capability from the cached Copilot models catalog.
 *
 * Usage:
 *   tsx tests/probes/visionCapabilities.ts            # uses ~/.copillm/models.cache.json
 *   tsx tests/probes/visionCapabilities.ts <path>     # uses a specific cache file
 *   tsx tests/probes/visionCapabilities.ts --json     # JSON output
 *
 * Reads from the on-disk cache written by src/models/discovery.ts. Run copillm
 * once (or `copillm models`) to refresh the cache before probing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface CachedCatalog {
  version: number;
  accountType: string;
  savedAtIso: string;
  models: Array<Record<string, unknown>>;
}

interface VisionLimits {
  max_prompt_image_size?: number;
  max_prompt_images?: number;
  supported_media_types?: string[];
}

interface Row {
  id: string;
  vendor: string;
  family: string;
  supportsVision: boolean;
  limits: VisionLimits | null;
  endpoints: string[];
}

function getNested<T>(obj: unknown, ...keys: string[]): T | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur as T;
}

function loadCatalog(filePath: string): CachedCatalog {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as CachedCatalog;
}

function summarize(model: Record<string, unknown>): Row {
  return {
    id: String(model.id ?? "<unknown>"),
    vendor: String(model.vendor ?? ""),
    family: getNested<string>(model, "capabilities", "family") ?? "",
    supportsVision: getNested<boolean>(model, "capabilities", "supports", "vision") === true,
    limits: getNested<VisionLimits>(model, "capabilities", "limits", "vision") ?? null,
    endpoints: (getNested<string[]>(model, "supported_endpoints") ?? []).filter(
      (e): e is string => typeof e === "string"
    )
  };
}

function formatTable(rows: Row[]): string {
  const headers = ["ID", "VENDOR", "FAMILY", "VISION", "IMGS", "MAX BYTES", "MEDIA TYPES"];
  const data = rows.map((r) => [
    r.id,
    r.vendor,
    r.family,
    r.supportsVision ? "yes" : "no",
    r.limits?.max_prompt_images != null ? String(r.limits.max_prompt_images) : "-",
    r.limits?.max_prompt_image_size != null ? String(r.limits.max_prompt_image_size) : "-",
    r.limits?.supported_media_types?.join(",") ?? "-"
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length))
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(headers), fmt(widths.map((w) => "-".repeat(w))), ...data.map(fmt)].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  const cachePath =
    positional[0] ?? path.join(os.homedir(), ".copillm", "models.cache.json");

  if (!fs.existsSync(cachePath)) {
    console.error(`Cache file not found: ${cachePath}`);
    console.error("Run copillm at least once to populate the models cache.");
    process.exit(1);
  }

  const catalog = loadCatalog(cachePath);
  const rows = catalog.models.map(summarize).sort((a, b) => {
    if (a.supportsVision !== b.supportsVision) return a.supportsVision ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          source: cachePath,
          accountType: catalog.accountType,
          savedAtIso: catalog.savedAtIso,
          counts: {
            total: rows.length,
            vision: rows.filter((r) => r.supportsVision).length,
            textOnly: rows.filter((r) => !r.supportsVision).length
          },
          models: rows
        },
        null,
        2
      )
    );
    return;
  }

  const visionCount = rows.filter((r) => r.supportsVision).length;
  console.log(`source:       ${cachePath}`);
  console.log(`accountType:  ${catalog.accountType}`);
  console.log(`savedAtIso:   ${catalog.savedAtIso}`);
  console.log(`models:       ${rows.length} total, ${visionCount} with vision\n`);
  console.log(formatTable(rows));
}

main();
