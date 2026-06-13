import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyDevModeEnv,
  DEFAULT_DEV_PORT,
  DEV_HOME_DIRNAME,
  isDevModeActive,
  isDevModeRequested,
  resolveDevHome,
  resolveDevPort
} from "../../../src/cli/shared/devMode.js";
import { getCopillmHome } from "../../../src/config/home.js";

const ENV_KEYS = ["COPILLM_DEV", "COPILLM_HOME", "COPILLM_PORT", "COPILLM_DEV_HOME", "COPILLM_DEV_PORT"] as const;

const DEV_HOME = path.join(os.homedir(), DEV_HOME_DIRNAME);

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("isDevModeRequested", () => {
  it("is false with no flag and no env", () => {
    expect(isDevModeRequested()).toBe(false);
  });

  it("is true when the --dev flag is passed", () => {
    expect(isDevModeRequested(true)).toBe(true);
  });

  it.each(["1", "true", "TRUE", "yes", "On"])("treats COPILLM_DEV=%s as active", (value) => {
    process.env.COPILLM_DEV = value;
    expect(isDevModeRequested()).toBe(true);
  });

  it.each(["0", "false", "no", "off", "", "   "])("treats COPILLM_DEV=%s as inactive", (value) => {
    process.env.COPILLM_DEV = value;
    expect(isDevModeRequested()).toBe(false);
  });
});

describe("resolveDevHome / resolveDevPort", () => {
  it("default to ~/.copillm-dev and port 4142", () => {
    expect(resolveDevHome()).toBe(DEV_HOME);
    expect(resolveDevPort()).toBe(String(DEFAULT_DEV_PORT));
  });

  it("honor COPILLM_DEV_HOME / COPILLM_DEV_PORT overrides", () => {
    process.env.COPILLM_DEV_HOME = path.join(os.tmpdir(), "custom-dev-home");
    process.env.COPILLM_DEV_PORT = "9999";
    expect(resolveDevHome()).toBe(path.resolve(path.join(os.tmpdir(), "custom-dev-home")));
    expect(resolveDevPort()).toBe("9999");
  });
});

describe("applyDevModeEnv", () => {
  it("is a no-op when dev mode is not requested", () => {
    const state = applyDevModeEnv();
    expect(state).toEqual({ active: false, home: null, port: null });
    expect(process.env.COPILLM_HOME).toBeUndefined();
    expect(process.env.COPILLM_PORT).toBeUndefined();
  });

  it("redirects COPILLM_HOME and COPILLM_PORT when active via the flag", () => {
    const state = applyDevModeEnv(true);
    expect(state.active).toBe(true);
    expect(process.env.COPILLM_HOME).toBe(DEV_HOME);
    expect(process.env.COPILLM_PORT).toBe(String(DEFAULT_DEV_PORT));
    // The rest of the codebase reads COPILLM_HOME through getCopillmHome().
    expect(getCopillmHome()).toBe(DEV_HOME);
  });

  it("activates via COPILLM_DEV env even without the flag", () => {
    process.env.COPILLM_DEV = "1";
    applyDevModeEnv();
    expect(process.env.COPILLM_HOME).toBe(DEV_HOME);
    expect(process.env.COPILLM_PORT).toBe(String(DEFAULT_DEV_PORT));
  });

  it("never overrides an explicitly set COPILLM_HOME", () => {
    const explicit = path.join(os.tmpdir(), "explicit-home");
    process.env.COPILLM_HOME = explicit;
    applyDevModeEnv(true);
    expect(process.env.COPILLM_HOME).toBe(explicit);
    // Port was unset, so it is still defaulted to the dev port.
    expect(process.env.COPILLM_PORT).toBe(String(DEFAULT_DEV_PORT));
  });

  it("never overrides an explicitly set COPILLM_PORT", () => {
    process.env.COPILLM_PORT = "5151";
    applyDevModeEnv(true);
    expect(process.env.COPILLM_PORT).toBe("5151");
    expect(process.env.COPILLM_HOME).toBe(DEV_HOME);
  });

  it("honors COPILLM_DEV_HOME / COPILLM_DEV_PORT overrides", () => {
    const devHome = path.join(os.tmpdir(), "devhome");
    process.env.COPILLM_DEV_HOME = devHome;
    process.env.COPILLM_DEV_PORT = "4343";
    applyDevModeEnv(true);
    expect(process.env.COPILLM_HOME).toBe(path.resolve(devHome));
    expect(process.env.COPILLM_PORT).toBe("4343");
  });

  it("is idempotent", () => {
    applyDevModeEnv(true);
    const home = process.env.COPILLM_HOME;
    const port = process.env.COPILLM_PORT;
    const state = applyDevModeEnv(true);
    expect(state.active).toBe(true);
    expect(process.env.COPILLM_HOME).toBe(home);
    expect(process.env.COPILLM_PORT).toBe(port);
  });

  it("marks dev mode active after an active apply", () => {
    applyDevModeEnv(true);
    expect(isDevModeActive()).toBe(true);
  });
});
