import { describe, expect, it } from "bun:test";

import { normalizeDiscordBlockquotes } from "../../../../src/surface/discord/output/discord-markdown-normalize";

describe("normalizeDiscordBlockquotes", () => {
  it("adds a space to bare blockquote continuation lines", () => {
    expect(normalizeDiscordBlockquotes("> first\n>\n> second")).toBe("> first\n> \n> second");
  });

  it("preserves already valid blockquote lines", () => {
    const input = "> first\n> \n>   \n> second";

    expect(normalizeDiscordBlockquotes(input)).toBe(input);
  });

  it("normalizes markdown blockquotes indented up to three spaces", () => {
    expect(normalizeDiscordBlockquotes(" >\n  >\n   >")).toBe(" > \n  > \n   > ");
  });

  it("does not normalize four-space indented code lines", () => {
    const input = "    >\ntext";

    expect(normalizeDiscordBlockquotes(input)).toBe(input);
  });

  it("preserves bare markers inside backtick fences", () => {
    const input = ["```md", ">", "```", ">"].join("\n");

    expect(normalizeDiscordBlockquotes(input)).toBe(["```md", ">", "```", "> "].join("\n"));
  });

  it("preserves bare markers inside tilde fences", () => {
    const input = ["~~~txt", ">", "~~~", ">"].join("\n");

    expect(normalizeDiscordBlockquotes(input)).toBe(["~~~txt", ">", "~~~", "> "].join("\n"));
  });

  it("preserves bare markers inside longer fences", () => {
    const input = ["````md", "```", ">", "```", "````", ">"].join("\n");

    expect(normalizeDiscordBlockquotes(input)).toBe(
      ["````md", "```", ">", "```", "````", "> "].join("\n"),
    );
  });

  it("treats unclosed fences as protected through end of input", () => {
    const input = ["```md", ">", ">"].join("\n");

    expect(normalizeDiscordBlockquotes(input)).toBe(input);
  });

  it("preserves CRLF line endings", () => {
    expect(normalizeDiscordBlockquotes("> first\r\n>\r\n> second")).toBe(
      "> first\r\n> \r\n> second",
    );
  });

  it("leaves text without blockquote markers unchanged", () => {
    const input = "plain text\nwith no markers";

    expect(normalizeDiscordBlockquotes(input)).toBe(input);
  });
});
