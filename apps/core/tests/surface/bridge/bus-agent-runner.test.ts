import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  appendAdditionalSessionMemoBlock,
  resolveSessionAdditionalPrompts,
  toOpenAIPromptCacheKey,
  withBlankLineBetweenTextParts,
  withReasoningSummaryDefaultForOpenAIModels,
} from "../../../src/surface/bridge/bus-agent-runner";

describe("toOpenAIPromptCacheKey", () => {
  it("returns the session id when it fits provider limits", () => {
    const sessionId = "sub:abc123";

    expect(toOpenAIPromptCacheKey(sessionId)).toBe(sessionId);
  });

  it("hashes long session ids down to 64 chars", () => {
    const sessionId =
      "sub:680343695673131032:sub:req:7984efa2-6f00-41c5-b1d0-bf77ada46e59:309873d2-712a-424e-9dd1-45273b4655d9";

    const key = toOpenAIPromptCacheKey(sessionId);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).not.toBe(sessionId);
  });
});

describe("withReasoningSummaryDefaultForOpenAIModels", () => {
  it("does not inject reasoning summary when display is none", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "none",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toBeUndefined();
  });

  it("injects detailed reasoning summary for openai provider", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toEqual({
      openai: {
        reasoningSummary: "detailed",
      },
    });
  });

  it("injects for vercel/openai/* and openrouter/openai/* models", () => {
    const vercel = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "openai/gpt-5",
      providerOptions: { gateway: { order: ["openai"] } },
    });

    const openrouter = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
      providerOptions: { openrouter: { route: "fallback" } },
    });

    expect(vercel?.openai?.reasoningSummary).toBe("detailed");
    expect(openrouter?.openai?.reasoningSummary).toBe("detailed");
  });

  it("does not override explicit reasoningSummary", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: {
        openai: {
          reasoningSummary: "auto",
          parallelToolCalls: true,
        },
      },
    });

    expect(next).toEqual({
      openai: {
        reasoningSummary: "auto",
        parallelToolCalls: true,
      },
    });
  });
});

describe("resolveSessionAdditionalPrompts", () => {
  it("keeps literal prompts and drops empty entries", async () => {
    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["  Keep answers short.  ", "\n\n", "   "],
    });

    expect(prompts).toEqual(["Keep answers short."]);
  });

  it("loads file:// prompts with filename and location header", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-runner-prompts-"));
    try {
      const memoPath = path.join(dir, "session-notes.md");
      await writeFile(memoPath, "be strict about scope\n", "utf8");

      const prompts = await resolveSessionAdditionalPrompts({
        entries: [pathToFileURL(memoPath).toString()],
      });

      expect(prompts).toEqual([`# session-notes.md (${memoPath})\nbe strict about scope`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips unreadable file prompts and reports a warning", async () => {
    const warnings: string[] = [];

    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["file:///tmp/does-not-exist-session-prompt.md"],
      onWarn: (warning) => warnings.push(warning.reason),
    });

    expect(prompts).toEqual([]);
    expect(warnings).toEqual(["read_failed"]);
  });
});

describe("appendAdditionalSessionMemoBlock", () => {
  it("appends Additional Session Memo at the end", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["Line one", "Line two"]);

    expect(out).toBe("Base prompt\n\nAdditional Session Memo:\nLine one\n\nLine two");
  });

  it("omits the block when combined memo is empty", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["  ", "\n\n"]);
    expect(out).toBe("Base prompt");
  });
});

describe("withBlankLineBetweenTextParts", () => {
  it("adds a blank line when text part id changes", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\n\nPart two.");
  });

  it("extends an existing trailing newline to a blank line", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not duplicate existing blank-line separation", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("Part two.");
  });

  it("keeps provider whitespace when delta already starts with whitespace", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "\nPart two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not change deltas when part did not change", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: false,
    });

    expect(out).toBe("Part two.");
  });

  it("supports restart recovery boundaries with prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Sure! Triggering now - see you on the other side.",
      delta: "...and I'm back.",
      partChanged: true,
    });

    expect(out).toBe("\n\n...and I'm back.");
  });

  it("does not add separator when there is no prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "",
      delta: "Fresh reply.",
      partChanged: true,
    });

    expect(out).toBe("Fresh reply.");
  });
});
