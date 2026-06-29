import { describe, expect, it } from "bun:test";

import {
  formatSurfaceMetadataLine,
  parseSurfaceMetadataLine,
  stripLeadingSurfaceMetadataLine,
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
});
