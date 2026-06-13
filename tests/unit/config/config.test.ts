import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath } from "../../../src/config/home.js";
import { loadConfig } from "../../../src/config/config.js";

let tmpHome: string;
let savedCopillmHome: string | undefined;
let savedCopillmPort: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-config-test-"));
  savedCopillmHome = process.env.COPILLM_HOME;
  savedCopillmPort = process.env.COPILLM_PORT;
  process.env.COPILLM_HOME = tmpHome;
  delete process.env.COPILLM_PORT;
});

afterEach(() => {
  if (savedCopillmHome === undefined) delete process.env.COPILLM_HOME;
  else process.env.COPILLM_HOME = savedCopillmHome;
  if (savedCopillmPort === undefined) delete process.env.COPILLM_PORT;
  else process.env.COPILLM_PORT = savedCopillmPort;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeConfig(content: string): void {
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "config.yaml"), content);
}

describe("loadConfig", () => {
  it("uses the configured preferredPort when COPILLM_PORT is unset", () => {
    writeConfig("preferredPort: 4545\nrequireCallerSecret: false\nselectedModels: []\naccountType: individual\n");

    expect(loadConfig().preferredPort).toBe(4545);
  });

  it("lets COPILLM_PORT override config.yaml without rewriting the file", () => {
    writeConfig("preferredPort: 4545\nrequireCallerSecret: false\nselectedModels: []\naccountType: individual\n");
    process.env.COPILLM_PORT = "5656";

    expect(loadConfig().preferredPort).toBe(5656);
    expect(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf8")).toContain("preferredPort: 4545");
  });

  it("applies COPILLM_PORT when loadConfig creates the default config", () => {
    process.env.COPILLM_PORT = "5757";

    expect(loadConfig().preferredPort).toBe(5757);
    expect(fs.readFileSync(configPath(), "utf8")).toContain("preferredPort: 4141");
  });

  it("ignores a blank COPILLM_PORT", () => {
    writeConfig("preferredPort: 4646\nrequireCallerSecret: false\nselectedModels: []\naccountType: individual\n");
    process.env.COPILLM_PORT = "  ";

    expect(loadConfig().preferredPort).toBe(4646);
  });

  it("rejects an invalid COPILLM_PORT", () => {
    process.env.COPILLM_PORT = "not-a-port";

    expect(() => loadConfig()).toThrow("Invalid COPILLM_PORT");
  });
});
