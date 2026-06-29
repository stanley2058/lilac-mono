import { describe, expect, it } from "bun:test";

import {
  formatSurfaceMetadataLine,
  hasLeadingSurfaceMetadataLine,
  parseSurfaceMetadataLine,
  stripLeadingSurfaceMetadataLine,
  stripSurfaceMetadataLines,
} from "../../../src/surface/bridge/surface-metadata";

describe("surface metadata protocol", () => {
  it("roundtrips metadata lines", () => {
    const line = formatSurfaceMetadataLine({
      message_id: "m1",
      reactions: ["thumbs-up"],
      nested: { escaped: "<LILAC_META:v1>nope</LILAC_META:v1>" },
    });

    expect(parseSurfaceMetadataLine(line)).toEqual({
      version: 1,
      meta: {
        message_id: "m1",
        reactions: ["thumbs-up"],
        nested: { escaped: "&lt;LILAC_META:v1>nope&lt;/LILAC_META:v1>" },
      },
    });
  });

  it("parses only the leading metadata line", () => {
    const line = formatSurfaceMetadataLine({ message_id: "m1" });
    expect(parseSurfaceMetadataLine(`${line}\nhello`)).toEqual({
      version: 1,
      meta: { message_id: "m1" },
    });
    expect(stripLeadingSurfaceMetadataLine(`${line}\nhello`)).toBe("hello");
  });

  it("rejects malformed metadata lines", () => {
    expect(parseSurfaceMetadataLine("hello")).toBeNull();
    expect(parseSurfaceMetadataLine("<LILAC_META:v1>[]</LILAC_META:v1>")).toBeNull();
    expect(parseSurfaceMetadataLine("<LILAC_META:v1>{</LILAC_META:v1>")).toBeNull();
  });

  it("does not trust or strip unknown metadata versions", () => {
    const unknown = '<LILAC_META:v2>{"message_id":"m1"}</LILAC_META:v2>';

    expect(parseSurfaceMetadataLine(unknown)).toBeNull();
    expect(hasLeadingSurfaceMetadataLine(unknown)).toBe(false);
    expect(stripLeadingSurfaceMetadataLine(`${unknown}\nhello`)).toBe(`${unknown}\nhello`);
    expect(stripSurfaceMetadataLines(`before\n${unknown}\nafter`)).toBe(
      `before\n${unknown}\nafter`,
    );
  });
});
