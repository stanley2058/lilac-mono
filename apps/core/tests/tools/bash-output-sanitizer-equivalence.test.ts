import { describe, expect, it } from "bun:test";

import {
  StreamingAnsiStripper,
  StreamingLiteralRedactor,
  StreamingSensitiveAssignmentRedactor,
} from "../../src/tools/bash-output-sanitizer";
import {
  ReferenceAnsiStripper,
  ReferenceLiteralRedactor,
  ReferenceSensitiveAssignmentRedactor,
} from "./bash-output-sanitizer-reference";

type Stage = { write(input: string): string; end?(): string };

const CASES_PER_STAGE = 4000;

function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("pick needs a non-empty list");
  return value;
}

function buildText(random: () => number, tokens: readonly string[]): string {
  const count = 1 + Math.floor(random() * 60);
  let text = "";
  for (let index = 0; index < count; index += 1) text += pick(random, tokens);
  return text;
}

function splitText(random: () => number, text: string): string[] {
  const maxChunk = pick(random, [1, 2, 3, 7, 40, 4096]);
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  let index = 0;
  while (index < codePoints.length) {
    // The decoder hands a stage an empty string when a chunk ends inside a UTF-8 sequence.
    if (random() < 0.1) chunks.push("");
    const size = 1 + Math.floor(random() * maxChunk);
    chunks.push(codePoints.slice(index, index + size).join(""));
    index += size;
  }
  return chunks;
}

function runStage(stage: Stage, chunks: readonly string[]): string[] {
  const outputs = chunks.map((chunk) => stage.write(chunk));
  if (stage.end) outputs.push(stage.end());
  return outputs;
}

function expectSameOutputs(params: {
  readonly seed: number;
  readonly tokens: readonly string[];
  readonly create: (random: () => number) => { readonly actual: Stage; readonly expected: Stage };
}): void {
  const random = createRandom(params.seed);
  for (let index = 0; index < CASES_PER_STAGE; index += 1) {
    const chunks = splitText(random, buildText(random, params.tokens));
    const { actual, expected } = params.create(random);
    const actualOutputs = runStage(actual, chunks);
    const expectedOutputs = runStage(expected, chunks);
    if (Bun.deepEquals(actualOutputs, expectedOutputs)) continue;
    expect({ chunks, outputs: actualOutputs }).toEqual({ chunks, outputs: expectedOutputs });
  }
}

const PLAIN_TOKENS = ["a", "Z", "9", "_", " ", "\n", "\t", "-", ".", "é", "漢", "😀", " "];

describe("bash output sanitizer stages match the per-character reference", () => {
  it("strips the same ANSI sequences and control characters", () => {
    expectSameOutputs({
      seed: 1,
      tokens: [
        ...PLAIN_TOKENS,
        "\u001b",
        "\u001b[",
        "\u001b]",
        "\u001b[31m",
        "\u001b]0;title",
        "\u0007",
        "\u009b",
        "\u009c",
        "\u009d",
        "\\",
        "\r",
        "\u0000",
        "\u007f",
        "\u0085",
        "[",
        "]",
        "m",
        ";",
        "~",
        "@",
      ],
      create: () => ({
        actual: new StreamingAnsiStripper(),
        expected: new ReferenceAnsiStripper(),
      }),
    });
  });

  it("redacts and holds back the same literal secrets", () => {
    const secretPool = [
      "abc",
      "abcabd",
      "aa",
      "aab",
      "hunter2",
      "a.b*c",
      "$(x)|[y]",
      "se cret\nline",
      "😀key",
      "漢",
      "\ud800",
    ];
    expectSameOutputs({
      seed: 2,
      tokens: [...PLAIN_TOKENS, ...secretPool, "a", "a", "b", "c", "ab", "hunter", "😀", "se cret"],
      create: (random) => {
        const count = Math.floor(random() * 4);
        const secrets = Array.from({ length: count }, () => pick(random, secretPool));
        return {
          actual: new StreamingLiteralRedactor(secrets),
          expected: new ReferenceLiteralRedactor(secrets),
        };
      },
    });
  });

  it("redacts the same sensitive assignments", () => {
    expectSameOutputs({
      seed: 3,
      tokens: [
        ...PLAIN_TOKENS,
        "=",
        "=",
        "TOKEN",
        "secret",
        "PassWord",
        "PASS",
        "key",
        "CREDENTIALS",
        "CREDENTIAL",
        "TOK",
        "EN",
        "KE",
        "Y",
        "paſs",
        "Key",
        "ſ",
        "K",
        "API_",
        "value",
        "x1",
        " ",
        "　",
        "﻿",
        "\u000b",
        "\r",
      ],
      create: () => ({
        actual: new StreamingSensitiveAssignmentRedactor(),
        expected: new ReferenceSensitiveAssignmentRedactor(),
      }),
    });
  });
});
