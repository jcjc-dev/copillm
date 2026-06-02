import { describe, expect, it } from "vitest";
import { buildSelfSpawnCommand } from "../../../src/cli/daemon/selfSpawn.js";

describe("buildSelfSpawnCommand", () => {
  it("spawns node with the current CLI entry when running from npm", () => {
    expect(
      buildSelfSpawnCommand("daemon", ["--debug"], {
        execPath: "/usr/local/bin/node",
        argv: ["/usr/local/bin/node", "/usr/local/lib/node_modules/copillm/dist/cli.js", "start"]
      })
    ).toEqual({
      command: "/usr/local/bin/node",
      args: ["/usr/local/lib/node_modules/copillm/dist/cli.js", "daemon", "--debug"]
    });
  });

  it("spawns the executable directly when running as a standalone binary", () => {
    expect(
      buildSelfSpawnCommand("daemon", [], {
        execPath: "/opt/copillm/bin/copillm",
        argv: ["/opt/copillm/bin/copillm", "/opt/copillm/bin/copillm", "start"]
      })
    ).toEqual({
      command: "/opt/copillm/bin/copillm",
      args: ["daemon"]
    });
  });

  it("spawns the executable directly when argv does not include a script path", () => {
    expect(
      buildSelfSpawnCommand("daemon", [], {
        execPath: "/opt/copillm/bin/copillm",
        argv: ["/opt/copillm/bin/copillm"]
      })
    ).toEqual({
      command: "/opt/copillm/bin/copillm",
      args: ["daemon"]
    });
  });
});
