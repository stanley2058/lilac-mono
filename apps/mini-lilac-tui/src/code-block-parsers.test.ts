import { describe, expect, it } from "bun:test";

import { CODE_BLOCK_PARSERS, registerCodeBlockParsers } from "./code-block-parsers";

describe("code block parsers", () => {
  it("registers common non-bundled languages and fence aliases", () => {
    expect(CODE_BLOCK_PARSERS.map((parser) => parser.filetype)).toEqual([
      "python",
      "bash",
      "json",
      "yaml",
      "rust",
      "go",
    ]);
    expect(CODE_BLOCK_PARSERS.find((parser) => parser.filetype === "bash")?.aliases).toContain(
      "sh",
    );
    expect(CODE_BLOCK_PARSERS.find((parser) => parser.filetype === "yaml")?.aliases).toContain(
      "yml",
    );
  });

  it("can be registered repeatedly without duplicating application setup", () => {
    expect(() => {
      registerCodeBlockParsers();
      registerCodeBlockParsers();
    }).not.toThrow();
  });
});
