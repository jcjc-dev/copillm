#!/usr/bin/env node
// Removes the global `copillm-dev` command created by `npm run dev:link`.
// Leaves the production `copillm` install completely untouched.
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const NAME = "copillm-dev";
const prefix = execSync("npm prefix -g", { encoding: "utf8" }).trim();
const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
const files = process.platform === "win32" ? [`${NAME}.cmd`, `${NAME}.ps1`, NAME] : [NAME];

let removed = 0;
for (const file of files) {
  const target = join(binDir, file);
  if (existsSync(target)) {
    rmSync(target);
    removed += 1;
    console.log(`removed ${target}`);
  }
}
console.log(removed > 0 ? `Unlinked \`${NAME}\`.` : `No \`${NAME}\` shims found in ${binDir}.`);
