import { expect, test } from "bun:test";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AiSdkPiAgent } from "../ai-sdk-pi-agent";
import { ToolCallScheduler, groupToolCalls } from "../tool-call-scheduling";

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

test("groups read-only and side-effect calls separately in received order", () => {
  expect(
    groupToolCalls(
      [
        "grep",
        "read",
        "bash",
        "read",
        "write",
        "glob",
        "fuzzy_search",
        "write",
        "write",
        "bash",
        "bash",
        "read",
        "bash",
      ],
      (name) => name,
    ),
  ).toEqual([
    ["grep", "read"],
    ["bash"],
    ["read"],
    ["write"],
    ["glob", "fuzzy_search"],
    ["write"],
    ["write"],
    ["bash", "bash"],
    ["read"],
    ["bash"],
  ]);
});

test("treats mutation aliases as exclusive and unknown tools as side effects", () => {
  expect(
    groupToolCalls(
      [
        "mcp__lilac__read",
        "read_file",
        "model_catalog",
        "question",
        "mcp__lilac__bash",
        "subagent_delegate",
        "edit_file",
        "apply_patch",
        "mcp__lilac__patch",
        "write_file",
        "edit",
      ],
      (name) => name,
    ),
  ).toEqual([
    ["mcp__lilac__read", "read_file", "model_catalog"],
    ["question", "mcp__lilac__bash", "subagent_delegate"],
    ["edit_file"],
    ["apply_patch"],
    ["mcp__lilac__patch"],
    ["write_file"],
    ["edit"],
  ]);
});

test("AI SDK runs reads after side effects and retains result order", async () => {
  const first = Promise.withResolvers<void>();
  const bothStarted = Promise.withResolvers<void>();
  const patch = Promise.withResolvers<void>();
  const patchStarted = Promise.withResolvers<void>();
  const starts: string[] = [];
  const bash = Promise.withResolvers<void>();
  const bashStarted = Promise.withResolvers<void>();
  const calls = ["read", "grep", "bash", "read", "patch", "read"];
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          ...(++step === 1
            ? calls.map((toolName, index) => ({
                type: "tool-call" as const,
                toolCallId: String(index),
                toolName,
                input: "{}",
              }))
            : []),
          {
            type: "finish" as const,
            finishReason: {
              unified: step === 1 ? ("tool-calls" as const) : ("stop" as const),
              raw: "stop",
            },
            usage,
          },
        ],
      }),
    }),
  });
  const tools = Object.fromEntries(
    [...new Set(calls)].map((name) => [
      name,
      tool({
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
        execute: async (_, { toolCallId }) => {
          starts.push(toolCallId);
          if (starts.length === 2) bothStarted.resolve();
          if (toolCallId === "0" || toolCallId === "1") await first.promise;
          if (name === "bash") {
            bashStarted.resolve();
            await bash.promise;
            starts.push("2:end");
          }
          if (name === "patch") {
            patchStarted.resolve();
            await patch.promise;
          }
          return toolCallId;
        },
      }),
    ]),
  );
  const agent = new AiSdkPiAgent({ model, system: "test", tools });
  const run = agent.prompt("run tools");
  await bothStarted.promise;
  expect(starts).toEqual(["0", "1"]);
  first.resolve();
  await bashStarted.promise;
  expect(starts).toEqual(["0", "1", "2"]);
  bash.resolve();
  await patchStarted.promise;
  expect(starts).toEqual(["0", "1", "2", "2:end", "3", "4"]);
  patch.resolve();
  await run;
  expect(starts).toEqual(["0", "1", "2", "2:end", "3", "4", "5"]);
  expect(
    agent.state.messages.flatMap((message) =>
      message.role === "tool"
        ? message.content.map((part) => (part.type === "tool-result" ? part.toolCallId : null))
        : [],
    ),
  ).toEqual(["0", "1", "2", "3", "4", "5"]);
});

test("individual MCP calls wait for the previous group and release after failures", async () => {
  const scheduler = new ToolCallScheduler();
  const reads = Promise.withResolvers<void>();
  const readsStarted = Promise.withResolvers<void>();
  const bashes = Promise.withResolvers<void>();
  const bashesStarted = Promise.withResolvers<void>();
  const patchStarted = Promise.withResolvers<void>();
  const patch = Promise.withResolvers<void>();
  const starts: string[] = [];
  const execute = (name: string) => async () => {
    starts.push(name);
    if (starts.length === 2) readsStarted.resolve();
    if (starts.length === 4) bashesStarted.resolve();
    if (name === "read" || name === "grep") await reads.promise;
    if (name === "bash") await bashes.promise;
    if (name === "apply_patch") {
      patchStarted.resolve();
      await patch.promise;
      throw new Error("patch failed");
    }
  };
  const runs = ["read", "grep", "bash", "bash"].map((name) => scheduler.run(name, execute(name)));
  await readsStarted.promise;
  expect(starts).toEqual(["read", "grep"]);

  runs.push(scheduler.run("apply_patch", execute("apply_patch")));
  runs.push(scheduler.run("glob", execute("glob")));
  reads.resolve();
  await bashesStarted.promise;
  expect(starts).toEqual(["read", "grep", "bash", "bash"]);

  bashes.resolve();
  await patchStarted.promise;
  expect(starts).toEqual(["read", "grep", "bash", "bash", "apply_patch"]);
  patch.resolve();
  expect((await Promise.allSettled(runs)).map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "fulfilled",
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
  expect(starts).toEqual(["read", "grep", "bash", "bash", "apply_patch", "glob"]);
});

test("individual MCP reads join a running read group only when nothing waits ahead", async () => {
  const scheduler = new ToolCallScheduler();
  const firstRead = Promise.withResolvers<void>();
  const lateReadStarted = Promise.withResolvers<void>();
  const starts: string[] = [];
  const first = scheduler.run("read", async () => {
    starts.push("read");
    await firstRead.promise;
  });
  const late = scheduler.run("grep", async () => {
    starts.push("grep");
    lateReadStarted.resolve();
  });
  await lateReadStarted.promise;
  expect(starts).toEqual(["read", "grep"]);

  const bash = scheduler.run("bash", async () => {
    starts.push("bash");
  });
  const blockedRead = scheduler.run("glob", async () => {
    starts.push("glob");
  });
  await late;
  expect(starts).toEqual(["read", "grep"]);

  firstRead.resolve();
  await Promise.all([first, bash, blockedRead]);
  expect(starts).toEqual(["read", "grep", "bash", "glob"]);
});
