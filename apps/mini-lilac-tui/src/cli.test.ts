import { describe, expect, it } from "bun:test";

import { DEFAULT_SERVER_URL, parseCliOptions } from "./cli";

describe("parseCliOptions bearer token", () => {
  it("uses only explicit or Mini Lilac-specific credentials", () => {
    const input = { argv: [], cwd: process.cwd() };

    expect(
      parseCliOptions({
        ...input,
        env: { MINI_LILAC_TOKEN: " mini-token ", TOKEN: "ambient-token" },
      }).token,
    ).toBe("mini-token");
    expect(parseCliOptions({ ...input, env: { TOKEN: "ambient-token" } }).token).toBeUndefined();
    expect(
      parseCliOptions({
        ...input,
        argv: ["--server", DEFAULT_SERVER_URL, "--token", " explicit-token "],
        env: { MINI_LILAC_TOKEN: "mini-token" },
      }).token,
    ).toBe("explicit-token");
  });
});
