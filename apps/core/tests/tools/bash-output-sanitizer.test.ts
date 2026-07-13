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
  it("reports activity for each received output chunk", async () => {
    let activityCount = 0;
    const result = await readSanitizedStreamTextCapped(streamFromStrings(["one", "two"]), 100, {
      onActivity: () => {
        activityCount += 1;
      },
    });

    expect(result.text).toBe("onetwo");
    expect(activityCount).toBe(2);
  });

  it("redacts secrets split across chunks", async () => {
    expect(await sanitizeChunks(["before secret-", "token after"], ["secret-token"])).toBe(
      "before <redacted> after",
    );
  });

  it("applies pattern redaction across stream chunks", async () => {
    expect(await sanitizeChunks(["before API_TO", "KEN=secret-value", " after"], [])).toBe(
      "before API_TOKEN=<redacted> after",
    );
  });

  it("keeps assignment redaction state across the pattern buffer boundary", async () => {
    const prefix = "x".repeat(64 * 1024 - 6);
    expect(await sanitizeChunks([`${prefix} API_TO`, "KEN=secret-value", "-continued"], [])).toBe(
      `${prefix} API_TOKEN=<redacted>`,
    );
  });

  it("redacts nested assignments across the pattern buffer boundary", async () => {
    const prefix = "x".repeat(64 * 1024 - 10);
    expect(await sanitizeChunks([`${prefix} FOO=value:API_TO`, "KEN=secret-value"], [])).toBe(
      `${prefix} FOO=value:API_TOKEN=<redacted>`,
    );
  });

  it("retains fixed token prefixes across the pattern buffer boundary", async () => {
    const prefix = "x".repeat(64 * 1024 - 6);
    expect(await sanitizeChunks([`${prefix} githu`, "b_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ"], [])).toBe(
      `${prefix} <redacted>`,
    );
  });

  it("suppresses long token continuations after a pattern buffer flush", async () => {
    const prefix = "x".repeat(64 * 1024 - 300);
    const tokenStart = `github_pat_${"A".repeat(289)}`;
    const tokenEnd = `${"B".repeat(400)} suffix`;
    expect(await sanitizeChunks([`${prefix}${tokenStart}`, tokenEnd], [])).toBe(
      `${prefix}<redacted> suffix`,
    );
  });

  it("retains long URL credentials until their terminator", async () => {
    const prefix = "x".repeat(64 * 1024 - 300);
    const credentialStart = `https://user:${"a".repeat(287)}`;
    expect(
      await sanitizeChunks([`${prefix}${credentialStart}`, "password@example.com/path"], []),
    ).toBe(`${prefix}https://<redacted>:<redacted>@example.com/path`);
  });

  it("suppresses long authorization values through the line boundary", async () => {
    const value = "a".repeat(64 * 1024 - "Authorization: Bearer ".length);
    expect(
      await sanitizeChunks(
        [`Authorization: Bearer ${value}`, " nonce=VISIBLE-CREDENTIAL\nsafe"],
        [],
      ),
    ).toBe("Authorization: <redacted>\nsafe");
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

  it("keeps only raw executor output in the temporary overflow spill", async () => {
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
      expect(await fs.readFile(overflowFilePath, "utf8")).toBe("prefix xyababa suffix");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("defers pattern redaction of overflow until artifact persistence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-output-sanitizer-"));
    const overflowFilePath = path.join(tempDir, "overflow.log");

    try {
      const result = await readSanitizedStreamTextCapped(
        streamFromStrings(["prefix API_TO", "KEN=secret-value suffix"]),
        8,
        { overflowFilePath },
      );

      expect(result.capped).toBeTrue();
      expect(await fs.readFile(overflowFilePath, "utf8")).toBe(
        "prefix API_TOKEN=secret-value suffix",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
