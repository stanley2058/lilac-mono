import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";

import { createBashOutputSanitizerTransform } from "../../src/tools/bash-output-sanitizer";

async function sanitizeChunks(
  chunks: readonly string[],
  secrets: readonly string[],
): Promise<string> {
  const output: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(
    createBashOutputSanitizerTransform(secrets),
  )) {
    output.push(Buffer.from(chunk));
  }
  return Buffer.concat(output).toString("utf8");
}

describe("bash output sanitizer stream", () => {
  it("redacts secrets split across chunks", async () => {
    expect(await sanitizeChunks(["before secret-", "token after"], ["secret-token"])).toBe(
      "before <redacted> after",
    );
  });

  it("redacts a boundary-spanning secret after an earlier complete occurrence", async () => {
    expect(await sanitizeChunks(["token xx to", "ken"], ["token"])).toBe(
      "<redacted> xx <redacted>",
    );
  });

  it("preserves canonical behavior for self-overlapping secrets", async () => {
    expect(await sanitizeChunks(["aaaa"], ["aaa"])).toBe("<redacted>a");
  });

  it("does not split Unicode surrogate pairs at the carry boundary", async () => {
    expect(await sanitizeChunks(["😀A"], ["abc"])).toBe("😀A");
  });

  it("strips split ANSI sequences before redacting", async () => {
    expect(
      await sanitizeChunks(
        ["before secret-\u001b[", "31mto", "ken\u001b[0m after"],
        ["secret-token"],
      ),
    ).toBe("before <redacted> after");
  });

  it("strips OSC sequences split across chunks", async () => {
    expect(
      await sanitizeChunks(["secret-\u001b]0;title", "\u001b", "\\token"], ["secret-token"]),
    ).toBe("<redacted>");
  });

  it("handles BEL after ESC inside an OSC sequence", async () => {
    expect(await sanitizeChunks(["\u001b]0;title\u001b", "\u0007SAFE"], ["secret"])).toBe("SAFE");
  });

  it("handles C1 ST and strips control characters before redaction", async () => {
    expect(await sanitizeChunks(["\u009dtitle\u009csec\rret\u0008-token"], ["secret-token"])).toBe(
      "<redacted>",
    );
  });

  it("preserves large output after the normal display cap", async () => {
    const prefix = "x".repeat(60 * 1024);
    const result = await sanitizeChunks([prefix, " secret-token suffix"], ["secret-token"]);
    expect(result.length).toBeGreaterThan(50 * 1024);
    expect(result.endsWith(" <redacted> suffix")).toBeTrue();
  });
});
