import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createToolResultArtifactStore,
  TOOL_RESULT_UNAVAILABLE_MESSAGE,
} from "../../src/artifacts/tool-result-artifact-store";
import { fsTool } from "../../src/tools/fs/fs";

describe("read_file tool-result resources", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-read-artifact-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("pages artifacts by Unicode character offset independent of cwd", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "call-a",
      toolName: "bash",
      content: "ab😀cd",
      ttlMs: 60_000,
      maxBytesPerSession: 1024,
    });
    const readFile = fsTool(baseDir, {
      toolResultArtifacts: store,
      requestContext: { requestId: "request-a", sessionId: "session-a" },
    }).read_file;

    const output = await readFile.execute!(
      {
        path: created.uri,
        cwd: "ssh-host:/ignored",
        start: { type: "offset", offset: 2 },
        maxCharacters: 2,
      },
      { toolCallId: "read-a", messages: [], context: {} },
    );
    expect(output).toEqual({
      success: true,
      kind: "artifact",
      resolvedPath: created.uri,
      content: "😀c",
      startOffset: 2,
      endOffset: 4,
      totalCharacters: 5,
      nextStart: { type: "offset", offset: 4 },
      hasMore: true,
    });

    const next = await readFile.execute!(
      { path: created.uri, start: { type: "offset", offset: 4 }, maxCharacters: 10 },
      { toolCallId: "read-next", messages: [], context: {} },
    );
    expect(next).toMatchObject({ content: "d", startOffset: 4, endOffset: 5, hasMore: false });
  });

  it("supports line starts for artifacts and offset starts for ordinary files", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "call-a",
      toolName: "bash",
      content: "first\nab😀cd",
      ttlMs: 60_000,
      maxBytesPerSession: 1024,
    });
    const readFile = fsTool(baseDir, {
      toolResultArtifacts: store,
      requestContext: { requestId: "request-a", sessionId: "session-a" },
    }).read_file;

    await writeFile(path.join(baseDir, "ordinary.txt"), "ab😀\ncd");

    const artifactWithLine = await readFile.execute!(
      {
        path: created.uri,
        start: { type: "line", line: 2, column: 2 },
        maxCharacters: 2,
      },
      { toolCallId: "artifact-line", messages: [], context: {} },
    );
    const fileWithOffset = await readFile.execute!(
      {
        path: "ordinary.txt",
        start: { type: "offset", offset: 2 },
        maxCharacters: 2,
      },
      { toolCallId: "file-offset", messages: [], context: {} },
    );

    expect(artifactWithLine).toMatchObject({
      success: true,
      content: "😀c",
      nextStart: { type: "line", line: 2, column: 4 },
    });
    expect(fileWithOffset).toMatchObject({
      success: true,
      content: "😀\n",
      nextStart: { type: "offset", offset: 4 },
    });
  });

  it("allows artifact reads but rejects filesystem paths in artifact-only mode", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "call-a",
      toolName: "bash",
      content: "restricted artifact",
      ttlMs: 60_000,
      maxBytesPerSession: 1024,
    });
    const readFile = fsTool(baseDir, {
      artifactOnly: true,
      toolResultArtifacts: store,
      requestContext: { requestId: "request-a", sessionId: "session-a" },
    }).read_file;

    const artifact = await readFile.execute!(
      { path: created.uri },
      { toolCallId: "read-artifact", messages: [], context: {} },
    );
    const ordinary = await readFile.execute!(
      { path: path.join(baseDir, "ordinary.txt") },
      { toolCallId: "read-ordinary", messages: [], context: {} },
    );

    expect(artifact).toMatchObject({ success: true, content: "restricted artifact" });
    expect(ordinary).toMatchObject({
      success: false,
      error: {
        code: "PERMISSION",
        message: "Restricted sessions can use read_file only with tool-result:// artifacts.",
      },
    });
  });

  it("does not reveal foreign or missing artifact existence", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "call-a",
      toolName: "bash",
      content: "secret",
      ttlMs: 60_000,
      maxBytesPerSession: 1024,
    });
    const readFile = fsTool(baseDir, {
      toolResultArtifacts: store,
      requestContext: { requestId: "request-b", sessionId: "session-b" },
    }).read_file;

    const foreign = await readFile.execute!(
      { path: created.uri },
      { toolCallId: "read-b", messages: [], context: {} },
    );
    const missing = await readFile.execute!(
      { path: "tool-result://00000000-0000-0000-0000-000000000000" },
      { toolCallId: "read-c", messages: [], context: {} },
    );
    const expected = {
      success: false,
      error: { code: "UNKNOWN", message: TOOL_RESULT_UNAVAILABLE_MESSAGE },
    };
    expect(foreign).toMatchObject(expected);
    expect(missing).toMatchObject(expected);
  });

  it("reports evicted artifacts as unavailable", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const first = await store.create({
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "call-a",
      toolName: "bash",
      content: "123456",
      ttlMs: 60_000,
      maxBytesPerSession: 8,
    });
    await store.create({
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "call-b",
      toolName: "bash",
      content: "abcdef",
      ttlMs: 60_000,
      maxBytesPerSession: 8,
    });
    const readFile = fsTool(baseDir, {
      toolResultArtifacts: store,
      requestContext: { requestId: "request-a", sessionId: "session-a" },
    }).read_file;
    const output = await readFile.execute!(
      { path: first.uri },
      { toolCallId: "read-evicted", messages: [], context: {} },
    );
    expect(output).toMatchObject({
      success: false,
      error: { message: TOOL_RESULT_UNAVAILABLE_MESSAGE },
    });
  });
});
