import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { startE2E, unusedPort, type E2E, type NativeSession } from "./harness";

const FIXTURE = path.join(import.meta.dir, "fixtures/mcp-server.ts");

let e2e: E2E;
let session: NativeSession;
let httpServer: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
beforeAll(async () => {
  const port = await unusedPort();
  httpServer = Bun.spawn([process.execPath, FIXTURE, "http", String(port)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = httpServer.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  e2e = await startE2E({
    mcpServers: {
      fixture: {
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE, "stdio"],
        allowSubagents: false,
      },
      remote: { transport: "http", url: `http://127.0.0.1:${port}/mcp`, allowSubagents: false },
    },
  });
  session = await e2e.session({ style: "web" });
}, 60_000);
afterAll(async () => {
  await e2e?.[Symbol.asyncDispose]();
  httpServer?.kill();
  await httpServer?.exited;
  expect(e2e?.model.unhandled ?? []).toEqual([]);
}, 60_000);

const MCP_TOOLS = [
  "mcp_fixture_echo",
  "mcp_fixture_explode",
  "mcp_fixture_pixel",
  "mcp_fixture_weather",
  "mcp_remote_echo",
];

test("the agent finds and calls tools from stdio and HTTP MCP servers", async () => {
  const tag = e2e.model.script("mcp", (request, model) => {
    switch (model.step) {
      case 0:
        // MCP tools are deferred until the agent searches for them.
        expect(request.tools).toContain("find_tools");
        expect(request.tools.filter((tool) => tool.startsWith("mcp_"))).toEqual([]);
        return {
          toolCalls: [{ name: "find_tools", args: { query: "echo weather pixel explode" } }],
        };
      case 1:
        expect(request.tools).toEqual(expect.arrayContaining(MCP_TOOLS));
        return { toolCalls: [{ name: "mcp_fixture_echo", args: { message: "hello" } }] };
      case 2:
        expect(model.result("mcp_fixture_echo")).toContain("mcp-echo:hello");
        return { toolCalls: [{ name: "mcp_fixture_weather", args: { city: "Taipei" } }] };
      case 3:
        // The fixture mirrors its structured output as JSON text, so the model gets it once.
        expect(model.result("mcp_fixture_weather").split('\\"celsius\\":21')).toHaveLength(2);
        return { toolCalls: [{ name: "mcp_fixture_pixel", args: {} }] };
      case 4:
        expect(model.result("mcp_fixture_pixel")).toContain('"mediaType":"image/png"');
        return { toolCalls: [{ name: "mcp_fixture_explode", args: {} }] };
      case 5:
        expect(model.result("mcp_fixture_explode")).toContain("mcp-failure: fixture refused");
        return { toolCalls: [{ name: "mcp_remote_echo", args: { message: "over http" } }] };
      default:
        expect(model.result("mcp_remote_echo")).toContain("mcp-echo:over http");
        return { text: "MCP done." };
    }
  });
  const threadId = await session.createThread("MCP");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} Use the MCP tools.`);
  const [turn] = await session.settled(store, 1);
  expect(turn!.assistant).toBe("MCP done.");
  expect(
    turn!.activities
      .filter((activity) => activity.label.startsWith("mcp_"))
      .map((activity) => [activity.label.split(" ")[0], activity.state, activity.output]),
  ).toEqual([
    ["mcp_fixture_echo", "complete", "mcp-echo:hello"],
    ["mcp_fixture_weather", "complete", expect.stringContaining('"celsius":21')],
    ["mcp_fixture_pixel", "complete", expect.stringContaining("Here is the pixel.")],
    ["mcp_fixture_explode", "failed", "mcp-failure: fixture refused"],
    ["mcp_remote_echo", "complete", "mcp-echo:over http"],
  ]);
}, 60_000);
