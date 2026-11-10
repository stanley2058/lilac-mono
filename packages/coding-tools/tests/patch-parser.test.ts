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
