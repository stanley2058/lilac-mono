import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { createMCPClient } from "@ai-sdk/mcp";
import { createGatewayHandler } from "../../../../computer-use-gateway/src/server";
import { withMcpSessionHeaders, hashMcpSession } from "../../mcp/session-context";
import { NativeStore } from "./store";
import { NativeComputer, decodeComputerViewer } from "./computer";

const ready = {
  status: "ready" as const,
  idle_timeout_seconds: 3600,
  generation: "generation-1",
  viewer_url: "http://localhost:17000/lilac-viewer.html",
  viewer_password: "test-only",
  expires_at: "2099-01-01T00:00:00.000Z",
};

test("viewer decoder rejects unsafe destinations, errors, and malformed responses", () => {
  expect(decodeComputerViewer({ structuredContent: ready }).unwrap().desktop?.generation).toBe(
    "generation-1",
  );
  expect(decodeComputerViewer({ structuredContent: { status: "absent" } }).unwrap()).toEqual({
    desktop: null,
  });
  for (const url of [
    "javascript:alert(1)",
    "https://user:password@host/lilac-viewer.html",
    "https://host/other",
    "https://host/lilac-viewer.html?password=secret",
  ]) {
    expect(decodeComputerViewer({ structuredContent: { ...ready, viewer_url: url } }).isErr()).toBe(
      true,
    );
  }
  expect(decodeComputerViewer({ isError: true, structuredContent: ready }).isErr()).toBe(true);
  expect(decodeComputerViewer({ content: [] }).isErr()).toBe(true);
});

test("native authorization and canonical session binding protect automatic viewer login", async () => {
  const db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  for (const id of ["owner", "guest"])
    store
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
      })
      .unwrap();
  const thread = store.createThread("owner", { commandId: "create" }).unwrap();
  const sessions: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: createGatewayHandler(
      {
        isReady: () => true,
        viewer: (session) => {
          sessions.push(session);
          return Result.ok(ready);
        },
        provision: async () => {
          throw new Error("Viewer must not provision");
        },
        execute: async () => {
          throw new Error("Viewer must not execute");
        },
        terminate: async () => {
          throw new Error("Viewer must not terminate");
        },
      },
      "fixture-secret",
    ),
  });
  const client = await createMCPClient({
    transport: withMcpSessionHeaders({
      type: "http",
      url: `${server.url}mcp`,
      headers: { Authorization: "Bearer fixture-secret" },
    }),
  });
  try {
    const tools = await client.tools();
    const computer = new NativeComputer(store, {
      getCatalogServers: () => [
        {
          serverId: "renamed-gateway",
          allowSubagents: false,
          serverInfo: { name: "lilac-computer-use", version: "0.1.0" },
        },
      ],
      getTools: () => [
        {
          serverId: "renamed-gateway",
          rawName: "viewer",
          stableId: "viewer",
          identity: { source: "mcp", sourceId: "renamed-gateway", rawToolName: "viewer" },
          tool: tools.viewer!,
        },
      ],
    });
    expect((await computer.read("guest", { threadId: thread.id })).isErr()).toBe(true);
    expect(sessions).toEqual([]);
    store.shareThread("owner", { threadId: thread.id, userId: "guest", grant: "read" }).unwrap();
    expect((await computer.read("guest", { threadId: thread.id })).isErr()).toBe(true);
    expect(sessions).toEqual([]);
    expect((await computer.read("owner", { threadId: thread.id })).unwrap().desktop?.password).toBe(
      ready.viewer_password,
    );
    expect(sessions).toEqual([hashMcpSession(`native:${thread.id}`)]);
    tools.viewer!.execute = async () => {
      throw new Error("Transport failed");
    };
    expect((await computer.read("owner", { threadId: thread.id })).isErr()).toBe(true);
  } finally {
    await client.close();
    await server.stop(true);
    db.close();
  }
});
