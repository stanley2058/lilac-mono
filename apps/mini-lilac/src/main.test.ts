import { describe, expect, it } from "bun:test";

import { ensureServerDataDir, HELP_TEXT, runMiniLilac, type MiniLilacCommandRunners } from "./main";

function testRunners(calls: string[]): MiniLilacCommandRunners {
  return {
    tui: async (args) => {
      calls.push(`tui:${args.join("|")}`);
      return 23;
    },
    server: async (args) => {
      calls.push(`server:${args.join("|")}`);
    },
  };
}

describe("mini-lilac command", () => {
  it("gives bundled server utilities a package-safe data directory", () => {
    const defaultEnv: Record<string, string | undefined> = {};
    ensureServerDataDir(defaultEnv, "/home/tester");
    expect(defaultEnv.DATA_DIR).toBe("/home/tester/.local/state/mini-lilac");

    const xdgEnv: Record<string, string | undefined> = { XDG_STATE_HOME: "/state" };
    ensureServerDataDir(xdgEnv, "/home/tester");
    expect(xdgEnv.DATA_DIR).toBe("/state/mini-lilac");

    const explicitEnv: Record<string, string | undefined> = { DATA_DIR: "/custom/data" };
    ensureServerDataDir(explicitEnv, "/home/tester");
    expect(explicitEnv.DATA_DIR).toBe("/custom/data");
  });

  it("starts the TUI by default and supports an explicit tui command", async () => {
    const calls: string[] = [];
    const runners = testRunners(calls);

    expect(await runMiniLilac(["--server", "http://localhost"], runners)).toBe(23);
    expect(await runMiniLilac(["tui", "--session", "session-1"], runners)).toBe(23);
    expect(calls).toEqual(["tui:--server|http://localhost", "tui:--session|session-1"]);
  });

  it("forwards all server arguments without parsing them", async () => {
    const calls: string[] = [];

    expect(await runMiniLilac(["server", "auth", "codex", "--status"], testRunners(calls))).toBe(0);
    expect(calls).toEqual(["server:auth|codex|--status"]);
  });

  it("owns top-level help without loading a client", async () => {
    const calls: string[] = [];
    let output = "";

    expect(
      await runMiniLilac(["--help"], testRunners(calls), (text) => void (output += text)),
    ).toBe(0);
    expect(calls).toEqual([]);
    expect(output).toBe(HELP_TEXT);
    expect(output).toContain("mini-lilac server [server-options]");
  });
});
