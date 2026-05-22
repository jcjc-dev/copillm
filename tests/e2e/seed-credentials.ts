import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FIXTURE_GITHUB_TOKEN } from "../mock-backend/fixtures.js";

export interface SeededHome {
  copillmHome: string;
  cleanup: () => void;
}

export function seedFreshHome(input?: { githubToken?: string; accountType?: "individual" | "business" | "enterprise" }): SeededHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-test-"));
  const home = path.join(root, ".copillm");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);

  const credentialsPath = path.join(home, "credentials.json");
  const payload = {
    version: 1 as const,
    github_token: input?.githubToken ?? FIXTURE_GITHUB_TOKEN,
    account_type: input?.accountType ?? "individual",
    saved_at: new Date().toISOString()
  };
  fs.writeFileSync(credentialsPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.chmodSync(credentialsPath, 0o600);

  return {
    copillmHome: home,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
}
