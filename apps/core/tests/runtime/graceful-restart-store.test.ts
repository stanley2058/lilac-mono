import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SqliteGracefulRestartStore,
  type GracefulRestartSnapshot,
} from "../../src/runtime/graceful-restart-store";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-graceful-store-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "graceful-restart.db");
  return new SqliteGracefulRestartStore(dbPath);
}

function buildSnapshot(): GracefulRestartSnapshot {
  return {
    version: 1,
    createdAt: Date.now(),
    deadlineMs: 3_000,
    agent: [
      {
        kind: "active",
        requestId: "discord:chan:msg_active",
        sessionId: "chan",
        requestClient: "discord",
        queue: "prompt",
        messages: [],
        raw: { sessionMode: "active" },
        recovery: {
          checkpointMessages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "starting",
                },
              ],
            },
          ],
          partialText: "starting",
        },
      },
      {
        kind: "queued",
        requestId: "discord:chan:msg_queued",
        sessionId: "chan",
        requestClient: "discord",
        queue: "prompt",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "check this file",
              },
              {
                type: "file",
                data: new URL("https://example.com/a.txt"),
                mediaType: "text/plain",
              },
            ],
          },
        ],
        raw: { triggerType: "mention" },
      },
    ],
    relays: [
      {
        requestId: "discord:chan:msg_active",
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        routerSessionMode: "active",
        replyTo: {
          platform: "discord",
          channelId: "chan",
          messageId: "msg_active",
        },
        createdOutputRefs: [
          {
            platform: "discord",
            channelId: "chan",
            messageId: "out_1",
          },
        ],
        visibleText: "partial",
        toolStatus: [
          {
            toolCallId: "tool_1",
            status: "start",
            display: "bash ls",
          },
        ],
        outCursor: "123-0",
      },
    ],
  };
}

describe("SqliteGracefulRestartStore", () => {
  it("saves and load-consumes completed snapshots", async () => {
    const store = await makeStore();
    const snapshot = buildSnapshot();

    store.saveCompletedSnapshot(snapshot);

    const loaded = store.loadAndConsumeCompletedSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(1);
    expect(loaded?.agent.length).toBe(2);
    expect(loaded?.relays.length).toBe(1);

    const queued = loaded?.agent.find((a) => a.kind === "queued");
    expect(queued).toBeDefined();

    const filePart = (queued?.messages[0] as { content?: unknown })?.content as
      | Array<{ type?: string; data?: unknown }>
      | undefined;
    const file = filePart?.find((p) => p.type === "file");
    expect(file?.data).toBeInstanceOf(URL);

    const secondLoad = store.loadAndConsumeCompletedSnapshot();
    expect(secondLoad).toBeNull();

    store.close();
  });

  it("clear removes pending snapshot", async () => {
    const store = await makeStore();
    store.saveCompletedSnapshot(buildSnapshot());
    store.clear();

    const loaded = store.loadAndConsumeCompletedSnapshot();
    expect(loaded).toBeNull();

    store.close();
  });
});
