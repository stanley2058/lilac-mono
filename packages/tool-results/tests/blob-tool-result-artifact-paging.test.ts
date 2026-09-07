import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";

import { createBlobBackedToolResultArtifactStore } from "../src/blob-tool-result-artifact-store";
import {
  adaptToolResultArtifactReadToAvailability,
  TOOL_RESULT_MAX_PAGE_CHARACTERS,
} from "../src/tool-result-artifact-store";

function createArtifactStore(rootDir: string, blobs: BlobStore) {
  const store = createBlobBackedToolResultArtifactStore(rootDir, blobs);
  const value = async <T>(
    resultPromise: Promise<{ status: "ok"; value: T } | { status: "error"; error: Error }>,
  ) => {
    const result = await resultPromise;
    if (result.status === "error") throw result.error;
    return result.value;
  };
  return {
    rootDir: store.rootDir,
    init: () => value(store.init()),
    create: (params: Parameters<typeof store.create>[0]) => value(store.create(params)),
    createFromFile: (params: Parameters<typeof store.createFromFile>[0]) =>
      value(store.createFromFile(params)),
    createFromStream: (params: Parameters<typeof store.createFromStream>[0]) =>
      value(store.createFromStream(params)),
    read: async (...params: Parameters<typeof store.read>) =>
      adaptToolResultArtifactReadToAvailability(await store.read(...params)),
    readWindow: async (...params: Parameters<typeof store.readWindow>) =>
      adaptToolResultArtifactReadToAvailability(await store.readWindow(...params)),
    maintain: (now?: number) => value(store.maintain(now)),
  };
}

describe("blob-backed tool result paging and quota", () => {
  let baseDir: string;
  let blobs: BlobStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-tool-result-paging-"));
    const created = await createMemoryBlobStore();
    if (created.status === "error") throw created.error;
    blobs = created.value;
  });

  afterEach(async () => {
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
    await rm(baseDir, { recursive: true, force: true });
  });

  function artifactParams(content: string, sessionId = "session-a") {
    return {
      sessionId,
      requestId: "request-a",
      toolCallId: "tool-a",
      toolName: "plugin-tool",
      content,
      ttlMs: 1000,
      maxBytesPerSession: 10,
    };
  }

  it("enforces a positive hard maximum for artifact pages", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("x".repeat(TOOL_RESULT_MAX_PAGE_CHARACTERS + 100)),
      maxBytesPerSession: 100_000,
    });

    const maximum = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 0 },
      maxCharacters: Number.MAX_SAFE_INTEGER,
      maxLines: 1,
    });
    expect(maximum.ok && maximum.content.length).toBe(TOOL_RESULT_MAX_PAGE_CHARACTERS);
    const positive = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 0 },
      maxCharacters: 0,
      maxLines: 0,
    });
    expect(positive.ok && positive.content.length).toBe(1);
  });

  it("reads offset windows in zero-based Unicode characters", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("A😀\nβZ"),
      maxBytesPerSession: 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 1 },
      maxCharacters: 2,
      maxLines: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "😀\n",
      startOffset: 1,
      endOffset: 3,
      totalCharacters: 5,
      hasMore: true,
      nextStart: { type: "offset", offset: 3 },
    });
  });

  it("caps artifact payload bytes and returns the exact Unicode continuation", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("A😀BéC"),
      maxBytesPerSession: 100,
    });

    const first = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 0 },
      maxCharacters: 100,
      maxLines: 10,
      maxOutputBytes: 5,
    });
    expect(first).toMatchObject({
      ok: true,
      content: "A😀",
      endOffset: 2,
      nextStart: { type: "offset", offset: 2 },
      hasMore: true,
    });

    if (!first.ok || !first.nextStart) throw new Error("expected artifact continuation");
    const second = await store.readWindow(created.uri, "session-a", {
      start: first.nextStart,
      maxCharacters: 100,
      maxLines: 10,
      maxOutputBytes: 4,
    });
    expect(second).toMatchObject({ ok: true, content: "BéC", hasMore: false });
  });

  it("rejects an artifact page budget too small for one Unicode character", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("😀x"),
      maxBytesPerSession: 100,
    });

    await expect(
      store.readWindow(created.uri, "session-a", {
        start: { type: "offset", offset: 0 },
        maxCharacters: 100,
        maxLines: 10,
        maxOutputBytes: 3,
      }),
    ).rejects.toThrow(
      "Tool result artifact maxOutputBytes must be at least 4 to fit one Unicode character",
    );
    expect((await store.read(created.uri, "session-a")).ok).toBe(true);
  });

  it("reads multiline windows from one-based lines and Unicode columns", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("zero\n😀ab\nlast"),
      maxBytesPerSession: 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 2, column: 1 },
      maxCharacters: 4,
      maxLines: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "ab\nl",
      startOffset: 6,
      endOffset: 10,
      totalCharacters: 13,
      hasMore: true,
      nextStart: { type: "line", line: 3, column: 1 },
    });
    if (!result.ok || !result.nextStart) throw new Error("Expected a continuation");
    const continuation = await store.readWindow(created.uri, "session-a", {
      start: result.nextStart,
      maxCharacters: 10,
      maxLines: 10,
    });
    expect(continuation).toMatchObject({
      ok: true,
      content: "ast",
      startOffset: 10,
      endOffset: 13,
      hasMore: false,
    });
  });

  it("clamps line columns to the line end", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("one\n二三\nend"),
      maxBytesPerSession: 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 2, column: 99 },
      maxCharacters: 2,
      maxLines: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "\ne",
      startOffset: 6,
      endOffset: 8,
      hasMore: true,
      nextStart: { type: "line", line: 3, column: 1 },
    });
  });

  it("normalizes starts beyond EOF to an empty EOF window", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("a😀\nlast"),
      maxBytesPerSession: 100,
    });

    const offset = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 999 },
      maxCharacters: 10,
      maxLines: 10,
    });
    const line = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 999, column: 999 },
      maxCharacters: 10,
      maxLines: 10,
    });

    expect(offset).toMatchObject({
      ok: true,
      content: "",
      startOffset: 7,
      endOffset: 7,
      totalCharacters: 7,
      hasMore: false,
    });
    expect(line).toMatchObject({
      ok: true,
      content: "",
      startOffset: 7,
      endOffset: 7,
      totalCharacters: 7,
      hasMore: false,
    });
    expect(offset.ok && offset.nextStart).toBeUndefined();
    expect(line.ok && line.nextStart).toBeUndefined();
  });

  it("caps and continues a long Unicode line exactly", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const content = "😀".repeat(TOOL_RESULT_MAX_PAGE_CHARACTERS + 2);
    const created = await store.create({
      ...artifactParams(content),
      maxBytesPerSession: Buffer.byteLength(content) + 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: Number.MAX_SAFE_INTEGER,
      maxLines: 1,
    });

    expect(result.ok && Array.from(result.content)).toHaveLength(TOOL_RESULT_MAX_PAGE_CHARACTERS);
    expect(result).toMatchObject({
      ok: true,
      startOffset: 0,
      endOffset: TOOL_RESULT_MAX_PAGE_CHARACTERS,
      totalCharacters: TOOL_RESULT_MAX_PAGE_CHARACTERS + 2,
      hasMore: true,
      nextStart: {
        type: "line",
        line: 1,
        column: TOOL_RESULT_MAX_PAGE_CHARACTERS,
      },
    });
  });

  it("keeps offset pages source-exact and line pages line-oriented", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("zero\none\ntwo"),
      maxBytesPerSession: 100,
    });

    const offset = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 2 },
      maxCharacters: 100,
      maxLines: 1,
    });
    const line = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 2, column: 1 },
      maxCharacters: 100,
      maxLines: 1,
    });

    expect(offset).toMatchObject({
      ok: true,
      content: "ro\n",
      startOffset: 2,
      endOffset: 5,
      hasMore: true,
      nextStart: { type: "offset", offset: 5 },
    });
    expect(line).toMatchObject({
      ok: true,
      content: "ne",
      startOffset: 6,
      endOffset: 9,
      hasMore: true,
      nextStart: { type: "line", line: 3, column: 0 },
    });
  });

  it("reconstructs artifact source exactly from offset pages limited by lines", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const source = "one\n😀two\nthree";
    const created = await store.create({
      ...artifactParams(source),
      maxBytesPerSession: 100,
    });
    const chunks: string[] = [];
    let offset = 0;

    for (let page = 0; page < 10; page += 1) {
      const result = await store.readWindow(created.uri, "session-a", {
        start: { type: "offset", offset },
        maxCharacters: 100,
        maxLines: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected artifact page");
      chunks.push(result.content);
      if (!result.nextStart) break;
      expect(result.nextStart.type).toBe("offset");
      if (result.nextStart.type !== "offset") throw new Error("expected offset continuation");
      expect(result.nextStart.offset).toBeGreaterThan(offset);
      offset = result.nextStart.offset;
    }

    expect(chunks.join("")).toBe(source);
  });

  it("counts empty lines and advances across their newline", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("a\n\nb"),
      maxBytesPerSession: 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 2 },
      maxCharacters: 100,
      maxLines: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "",
      startOffset: 2,
      endOffset: 3,
      totalCharacters: 4,
      hasMore: true,
      nextStart: { type: "line", line: 3, column: 0 },
    });
  });

  it("applies character precedence at line boundaries and clamps maxLines", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const created = await store.create({
      ...artifactParams("ab\ncd\nef"),
      maxBytesPerSession: 100,
    });

    const lineFirst = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: 4,
      maxLines: 0,
    });
    const sameBoundary = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: 3,
      maxLines: 1,
    });
    const newlineCharactersFirst = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: 3,
      maxLines: 2,
    });
    const charactersFirst = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: 2,
      maxLines: 2,
    });

    expect(lineFirst).toMatchObject({
      ok: true,
      content: "ab",
      endOffset: 3,
      nextStart: { type: "line", line: 2, column: 0 },
    });
    expect(sameBoundary).toMatchObject({
      ok: true,
      content: "ab",
      endOffset: 3,
      nextStart: { type: "line", line: 2, column: 0 },
    });
    expect(newlineCharactersFirst).toMatchObject({
      ok: true,
      content: "ab\n",
      endOffset: 3,
      nextStart: { type: "line", line: 2, column: 0 },
    });
    expect(charactersFirst).toMatchObject({
      ok: true,
      content: "ab",
      endOffset: 2,
      nextStart: { type: "line", line: 1, column: 2 },
    });
  });

  it("evicts oldest artifacts and retains an oversized artifact alone", async () => {
    const store = createArtifactStore(path.join(baseDir, "tool-results"), blobs);
    await store.init();
    const first = await store.create(artifactParams("123456"));
    const second = await store.create(artifactParams("abcdef"));
    expect(await store.read(first.uri, "session-a")).toEqual({ ok: false });
    expect((await store.read(second.uri, "session-a")).ok).toBe(true);

    const oversized = await store.create(artifactParams("this is oversized"));
    expect(oversized.oversized).toBe(true);
    expect(await store.read(second.uri, "session-a")).toEqual({ ok: false });
    expect((await store.read(oversized.uri, "session-a")).ok).toBe(true);

    const later = await store.create(artifactParams("later"));
    expect(await store.read(oversized.uri, "session-a")).toEqual({ ok: false });
    expect((await store.read(later.uri, "session-a")).ok).toBe(true);
  });
});
