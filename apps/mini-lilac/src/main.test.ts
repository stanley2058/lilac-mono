import { describe, expect, it } from "bun:test";

import { HELP_TEXT, runMiniLilac, type MiniLilacCommandRunners } from "./main";

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
