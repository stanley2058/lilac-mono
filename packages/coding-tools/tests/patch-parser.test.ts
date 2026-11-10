import { expect, test } from "bun:test";
import { parsePatchResult } from "../src/apply-patch";

test("patch parser preserves colon paths and recognizes EOF markers with CRLF", () => {
  const parsed = parsePatchResult(
    [
      "*** Begin Patch",
      "*** Update File: a:b",
      "*** Move to: c:d",
      "@@",
      "-before",
      "+after",
      "*** End of File",
      "*** End Patch",
    ].join("\r\n"),
  );
  expect(parsed.unwrap()).toEqual([
    {
      type: "update",
      path: "a:b",
      movePath: "c:d",
      chunks: [
        { oldLines: ["before"], newLines: ["after"], isEndOfFile: true, changeContext: undefined },
      ],
    },
  ]);
});
for (const header of ["Add", "Update"]) {
  test(`rejects unprefixed ${header} lines`, () => {
    expect(
      parsePatchResult(
        `*** Begin Patch\n*** ${header} File: a\n${header === "Update" ? "@@\n" : ""}unprefixed\n*** End Patch`,
      ).isErr(),
    ).toBe(true);
  });
}

test("keeps a space-prefixed blank context line before the next header", () => {
  const parsed = parsePatchResult("*** Begin Patch\n*** Update File: a\n@@\n+x\n \n*** End Patch");
  expect(parsed.unwrap()).toEqual([
    {
      type: "update",
      path: "a",
      movePath: undefined,
      chunks: [
        { oldLines: [""], newLines: ["x", ""], changeContext: undefined, isEndOfFile: undefined },
      ],
    },
  ]);
});

test("parses many blank separator lines in linear time", () => {
  const blanks = Array.from({ length: 50_000 }, () => "").join("\n");
  const started = performance.now();
  const parsed = parsePatchResult(
    `*** Begin Patch\n*** Update File: a\n@@\n-a\n+b\n${blanks}\n@@\n-c\n+d\n*** End Patch`,
  );
  expect(parsed.unwrap()[0]).toMatchObject({ type: "update", path: "a" });
  expect(performance.now() - started).toBeLessThan(250);
});
