import { describe, expect, it } from "bun:test";

import { DEFAULT_SERVER_URL } from "./cli";
import { continuationCommand } from "./continuation";

describe("continuationCommand", () => {
  it("prints the session id for the default server", () => {
    expect(continuationCommand(DEFAULT_SERVER_URL, "session-1")).toBe(
      "mini-lilac --session 'session-1'",
    );
  });

  it("preserves a custom server and shell-quotes values", () => {
    expect(continuationCommand("https://example.test/api", "session-'quoted")).toBe(
      "mini-lilac --server 'https://example.test/api' --session 'session-'\\''quoted'",
    );
  });
});
