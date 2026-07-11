import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  createBashOutputSanitizerTransform,
  readSanitizedStreamTextCapped,
} from "../../src/tools/bash-output-sanitizer";
import { redactLiteralSecrets } from "../../src/tools/bash-safety/format";

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

function chunkPartitions(input: string): string[][] {
  if (input.length === 0) return [[]];

  const partitions: string[][] = [];
  const boundaryCount = input.length - 1;
  for (let mask = 0; mask < 1 << boundaryCount; mask += 1) {
    const chunks: string[] = [];
    let start = 0;
    for (let index = 0; index < boundaryCount; index += 1) {
      if ((mask & (1 << index)) !== 0) {
        chunks.push(input.slice(start, index + 1));
        start = index + 1;
      }
    }
    chunks.push(input.slice(start));
    partitions.push(chunks);
  }
  return partitions;
}

function streamFromStrings(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function streamFromBytes(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
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

  it("rechecks earlier overlaps after moving the streaming boundary", async () => {
    expect(await sanitizeChunks(["xyababa"], ["aba"])).toBe("xy<redacted>ba");
  });

  it("matches batch redaction for every chunk partition", async () => {
    const cases = [
      { input: "xyababa", secrets: ["aba"] },
      { input: "aaaaaa", secrets: ["aaa"] },
      { input: "abababa", secrets: ["aba", "bab"] },
      { input: "tokenxxtoken", secrets: ["token", "tokenxx"] },
    ];

    for (const { input, secrets } of cases) {
      const expected = redactLiteralSecrets(input, secrets);
      for (const chunks of chunkPartitions(input)) {
        expect(await sanitizeChunks(chunks, secrets)).toBe(expected);
      }
    }
  });

  it("keeps repetitive self-overlapping output bounded", async () => {
    const input = "a".repeat(100_000);
    const result = await readSanitizedStreamTextCapped(streamFromStrings([input]), 1024, {
      literalSecrets: ["aaa"],
    });

    expect(result.capped).toBeTrue();
    expect(result.text.length).toBe(1024);
    expect(result.totalChars).toBeGreaterThan(100_000);
  });

  it("does not split Unicode surrogate pairs at the carry boundary", async () => {
    expect(await sanitizeChunks(["😀A"], ["abc"])).toBe("😀A");
  });

  it("normalizes malformed UTF-16 literals consistently", async () => {
    const input = "😀A";
    const secret = "\uDE00A";
    expect(await sanitizeChunks([input], [secret])).toBe(redactLiteralSecrets(input, [secret]));

    const malformed = "\uD800x";
    expect(await sanitizeChunks([malformed], [malformed])).toBe("<redacted>");
  });

  it("preserves UTF-8 characters split across byte chunks and cap boundaries", async () => {
    const bytes = new TextEncoder().encode("😀x");
    const result = await readSanitizedStreamTextCapped(
      streamFromBytes([bytes.slice(0, 2), bytes.slice(2)]),
      1,
    );

    expect(result.capped).toBeTrue();
    expect(result.text).toBe("");
    expect(result.totalChars).toBe(3);
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

  it("sanitizes before capping and writing overflow", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-output-sanitizer-"));
    const overflowFilePath = path.join(tempDir, "overflow.log");

    try {
      const result = await readSanitizedStreamTextCapped(
        streamFromStrings(["prefix xyab", "aba suffix"]),
        8,
        { overflowFilePath, literalSecrets: ["aba"] },
      );

      expect(result.capped).toBeTrue();
      expect(result.text).toBe("prefix x");
      expect(result.overflowFilePath).toBe(overflowFilePath);
      expect(await fs.readFile(overflowFilePath, "utf8")).toBe("prefix xy<redacted>ba suffix");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
