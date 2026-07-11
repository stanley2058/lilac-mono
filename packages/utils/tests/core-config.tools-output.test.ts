import { describe, expect, it } from "bun:test";

import { parseCoreConfig } from "../core-config";

const DEFAULT_TOOLS_POLICY = {
  output: {
    maxPreviewBytes: 40 * 1024,
    artifactTtlMs: 7 * 24 * 60 * 60 * 1000,
    artifactMaxBytesPerSession: 50 * 1024 * 1024,
  },
  historicalResultPruning: {
    enabled: false,
    protectTokens: 40_000,
    minimumTokens: 20_000,
  },
  batch: { maxCalls: 8 },
  media: {
    maxInlineBytesPerPart: 10 * 1024 * 1024,
    maxInlineBytesTotal: 20 * 1024 * 1024,
  },
};

describe("tool output config", () => {
  it("provides the universal policy defaults for v1 and v2", async () => {
    for (const configVersion of [1, 2] as const) {
      const parsed = await parseCoreConfig({ configVersion });
      expect(parsed.tools).toMatchObject(DEFAULT_TOOLS_POLICY);
    }
  });

  it("normalizes partial v2 friendly unit settings", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      tools: {
        output: {
          maxPreviewBytes: "5MB",
          artifactTtl: "6d",
        },
        media: {
          maxInlineBytesPerPart: "1MiB",
        },
      },
    });

    expect(parsed.tools.output).toEqual({
      maxPreviewBytes: 5_000_000,
      artifactTtlMs: 6 * 24 * 60 * 60 * 1000,
      artifactMaxBytesPerSession: 50 * 1024 * 1024,
    });
    expect(parsed.tools.media).toEqual({
      maxInlineBytesPerPart: 1024 * 1024,
      maxInlineBytesTotal: 20 * 1024 * 1024,
    });
  });

  it("rejects invalid friendly units", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        tools: { output: { maxPreviewBytes: "40K" } },
      }),
    ).rejects.toThrow();
  });

  it("rejects batch maxCalls above the absolute maximum", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        tools: { batch: { maxCalls: 9 } },
      }),
    ).rejects.toThrow();
  });
});
