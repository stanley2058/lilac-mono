import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileFinder } from "@ff-labs/fff-node";

import { FileSystem } from "../src";

describe("FFF fuzzy search failures", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-fuzzy-failure-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("preserves the established FileSystem error result when fileSearch throws", async () => {
    const fileSearch = spyOn(FileFinder.prototype, "fileSearch").mockImplementation(() => {
      throw new Error("FFF file search failed");
    });

    try {
      const result = await new FileSystem(root, { fsBackend: "fff" }).fuzzySearchFiles({
        query: "fixture",
      });

      expect(fileSearch).toHaveBeenCalled();
      expect(result).toEqual({
        results: [],
        totalMatched: 0,
        totalFiles: 0,
        truncated: false,
        error: "fuzzy file search is unavailable for this path",
      });
    } finally {
      fileSearch.mockRestore();
    }
  });

  it("falls back to fzf when fileSearch throws and fallback is enabled", async () => {
    await writeFile(path.join(root, "fixture-target.ts"), "export const target = true;\n");
    const fileSearch = spyOn(FileFinder.prototype, "fileSearch").mockImplementation(() => {
      throw new Error("FFF file search failed");
    });

    try {
      const result = await new FileSystem(root, {
        fsBackend: "fff",
        fuzzySearchFallback: "fzf",
      }).fuzzySearchFiles({ query: "fixture-target" });

      expect(fileSearch).toHaveBeenCalled();
      expect(result.error).toBeUndefined();
      expect(result.effectiveBackend).toBe("fzf");
      expect(result.results.map((entry) => entry.path)).toEqual(["fixture-target.ts"]);
    } finally {
      fileSearch.mockRestore();
    }
  });
});
