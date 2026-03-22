import { describe, expect, it } from "bun:test";

import { buildToolInput, parseArgs } from "./client";

describe("tool-bridge positional input", () => {
  it("parses a bare positional argument for tool calls", () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--mode=browser"]);

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.callableId).toBe("fetch");
    expect(parsed.positionalArgs).toEqual(["https://example.com"]);
    expect(parsed.fieldInputs).toEqual([{ field: "mode", value: "browser" }]);
  });

  it("supports `--` for positional values that begin with dashes", () => {
    const parsed = parseArgs(["fetch", "--", "--literal-value"]);

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.positionalArgs).toEqual(["--literal-value"]);
  });

  it("maps the primary positional argument into tool input", async () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--format=text"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "url" })).resolves.toEqual({
      url: "https://example.com",
      format: "text",
    });
  });

  it("rejects positional input for tools without primary positional metadata", async () => {
    const parsed = parseArgs(["search", "llms"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed)).rejects.toThrow(
      "Tool 'search' does not support positional input.",
    );
  });

  it("rejects duplicate positional and named input for the same field", async () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--url=https://other.example.com"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "url" })).rejects.toThrow(
      "Primary positional <url> conflicts with an existing 'url' value",
    );
  });
});
