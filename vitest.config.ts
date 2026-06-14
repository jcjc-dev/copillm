import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/globalBuild.ts"],
    // Keep vitest's defaults (node_modules, dist, …) and also ignore the
    // gitignored `.claude/` tree. Feature work happens in throwaway worktrees
    // under `.claude/worktrees/`, whose stale duplicate test files would
    // otherwise be collected and run from a top-level `npm test`.
    exclude: [...configDefaults.exclude, "**/.claude/**"]
  }
});
