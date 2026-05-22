import { spawnSync } from "node:child_process";
import path from "node:path";

// Vitest globalSetup: build the CLI exactly once before any test workers
// start. Previously each CLI-spawning test file called `tsc -p tsconfig.json`
// in its own beforeAll(). With vitest's parallel file scheduling, multiple
// tsc invocations would race to write into the same dist/ directory and
// clobber each other's output (silently emitting a half-written
// dist/cli.js), which manifested as widely-distributed flakes: child
// processes would exit with code 1 or empty output, failing whichever test
// happened to spawn it during the race.
//
// Doing the build once here removes the race entirely. Test files now
// assume dist/cli.js is present and re-buildable on demand.
export default function setup(): void {
  const repoRoot = path.resolve(__dirname, "..");
  const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tscEntry, "-p", "tsconfig.json"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`globalSetup failed to build CLI (exit=${result.status ?? "null"}).`);
  }
}
