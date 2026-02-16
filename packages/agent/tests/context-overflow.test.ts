import { describe, expect, it } from "bun:test";

import { isLikelyContextOverflowError } from "../context-overflow";

describe("isLikelyContextOverflowError", () => {
  it("matches common provider error messages", () => {
    expect(isLikelyContextOverflowError("maximum context length is 128000 tokens")).toBe(true);
    expect(isLikelyContextOverflowError("prompt is too long: 136621 tokens > 128000 maximum")).toBe(
      true,
    );
    expect(isLikelyContextOverflowError("context_length_exceeded")).toBe(true);
  });

  it("matches nested Error causes", () => {
    const err = new Error("request failed");
    (err as Error & { cause?: unknown }).cause = {
      error: {
        message: "Input is too long for the context window",
      },
    };

    expect(isLikelyContextOverflowError(err)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isLikelyContextOverflowError("rate limit exceeded")).toBe(false);
    expect(
      isLikelyContextOverflowError({
        message: "upstream timeout",
        statusCode: 504,
      }),
    ).toBe(false);
  });
});
