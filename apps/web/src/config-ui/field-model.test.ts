import { describe, expect, it } from "bun:test";
import { enumerateConfigFields } from "@stanley2058/lilac-utils/config-schema";
import { cleanDescription, describedDefault, splitDescription } from "./field-model";
import { configSchema } from "./schemas";

describe("schema help text", () => {
  it.each([
    [
      "Optional Discord surface database path. Defaults to DATA_DIR/discord-surface.db.",
      "Optional Discord surface database path.",
      "DATA_DIR/discord-surface.db",
    ],
    [
      "Retention time for tool-result artifacts. Default: 7d. Accepts positive milliseconds or a duration such as `7d`. Units: ms, s, m, h, d, w, mo; mo is 30 days.",
      "Retention time for tool-result artifacts.",
      "7d",
    ],
    [
      'Bot display name. Must not contain whitespace.\n\nDefault: `"lilac"`.',
      "Bot display name. Must not contain whitespace.",
      "lilac",
    ],
    [
      "Gateway TCP port, from 1 to 65535. Defaults to 8789.",
      "Gateway TCP port, from 1 to 65535.",
      "8789",
    ],
  ])("removes the default from %p", (text, cleaned, fallback) => {
    expect(cleanDescription(text)).toBe(cleaned);
    expect(describedDefault(text)).toBe(fallback);
  });

  it("splits after the first sentence", () => {
    expect(splitDescription("Portable effort. `provider-default` leaves it.")).toEqual({
      lead: "Portable effort.",
      rest: "`provider-default` leaves it.",
    });
    expect(splitDescription("One sentence only.")).toEqual({ lead: "One sentence only." });
  });
});

describe("schema descriptions", () => {
  it.each(["core", "mcp"] as const)("%s has balanced code spans", (kind) => {
    const { schema, root } = configSchema(kind);
    const unbalanced = enumerateConfigFields(schema, root)
      .map((field) => field.node.description ?? "")
      .filter((text) => (text.match(/`/gu) ?? []).length % 2 === 1);
    expect(unbalanced).toEqual([]);
  });
});
