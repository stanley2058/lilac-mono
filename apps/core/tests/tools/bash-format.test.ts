import { describe, expect, it } from "bun:test";

import { redactSecrets } from "../../src/tools/bash-safety/format";

describe("bash output redaction", () => {
  it("redacts dynamically injected tool environment values wherever they appear", () => {
    expect(redactSecrets("before arbitrary-token after", ["arbitrary-token"])).toBe(
      "before <redacted> after",
    );
  });

  it("ignores empty values and redacts overlapping values longest-first", () => {
    expect(redactSecrets("token-long token", ["", "token", "token-long"])).toBe(
      "<redacted> <redacted>",
    );
  });
});
