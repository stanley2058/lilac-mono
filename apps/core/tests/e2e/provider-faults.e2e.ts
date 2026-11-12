import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startE2E, type E2E, type ModelMessage, type NativeSession } from "./harness";

function expectPairedToolCalls(messages: ModelMessage[]) {
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? message.toolCalls.map((call) => call.id) : [],
  );
  const results = messages.flatMap((message) => (message.role === "tool" ? [message.callId] : []));
  expect(results.toSorted()).toEqual(calls.toSorted());
}

function previousResponseId(raw: unknown): unknown {
  return (raw as { previous_response_id?: unknown }).previous_response_id;
}

describe("OpenAI Responses over WebSocket", () => {
  let e2e: E2E;
  let session: NativeSession;
  beforeAll(async () => {
    e2e = await startE2E({
      provider: "responses-ws",
      config: { agent: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 } } },
    });
    session = await e2e.session({ style: "web" });
  }, 60_000);
  afterAll(async () => {
    await e2e?.[Symbol.asyncDispose]();
    expect(e2e?.model.unhandled ?? []).toEqual([]);
  }, 60_000);

  // Fails today: native Responses adapter failures reach the user as "Unknown operation failure".
  test.failing(
    "a socket closed for an oversized message fails the turn with the reason",
    async () => {
      // Forced WebSocket transport does not fall back after submission (PROJECT.md).
      const tag = e2e.model.script("ws-close", (_request, model) => {
        if (model.lastUserText.includes("smaller")) return { text: "Handled the smaller request." };
        if (model.step === 0)
          return { toolCalls: [{ name: "bash", args: { command: "echo before-close" } }] };
        return { fault: { kind: "close", code: 1009, reason: "Message too big" } };
      });
      const threadId = await session.createThread("WebSocket close");
      const store = session.watch(threadId);
      await session.send(threadId, `${tag} Go.`);
      const [turn] = await session.settled(store, 1);
      expect(turn!.state).toBe("failed");
      expect(JSON.stringify(turn!.messages)).toContain("too large");
      expect(turn!.activities.filter((activity) => activity.state === "running")).toEqual([]);
      await session.send(threadId, `${tag} Try something smaller.`);
      const turns = await session.settled(store, 2);
      expect(turns[1]!.assistant).toContain("Handled the smaller request.");
      expectPairedToolCalls(e2e.model.forScenario("ws-close").at(-1)!.request.messages);
    },
    60_000,
  );

  test("an expired continuation is retried with the full conversation", async () => {
    const tag = e2e.model.script("continuation-expired", (request, model) => {
      if (model.step === 0)
        return { toolCalls: [{ name: "bash", args: { command: "echo continued" } }] };
      if (typeof previousResponseId(request.raw) === "string")
        return {
          fault: {
            kind: "error",
            status: 400,
            code: "previous_response_not_found",
            message: "Previous response with id 'resp_gone' not found.",
          },
        };
      return { text: "Answered from full history." };
    });
    const threadId = await session.createThread("Continuation expired");
    const store = session.watch(threadId);
    await session.send(threadId, `${tag} Go.`);
    const [turn] = await session.settled(store, 1);
    expect(turn!.assistant).toContain("Answered from full history.");
    const last = e2e.model.forScenario("continuation-expired").at(-1)!.request;
    expect(previousResponseId(last.raw)).toBeUndefined();
    expect(JSON.stringify(last.messages)).toContain("continued");
    expectPairedToolCalls(last.messages);
  }, 60_000);

  test("a transient provider error is retried without duplicating output", async () => {
    let failed = false;
    const tag = e2e.model.script("transient", (_request, model) => {
      if (model.step === 0)
        return { toolCalls: [{ name: "bash", args: { command: "echo once" } }] };
      if (!failed) {
        failed = true;
        return {
          fault: {
            kind: "error",
            status: 500,
            code: "server_error",
            message: "The server had an error.",
          },
        };
      }
      return { text: "Answered after retry." };
    });
    const threadId = await session.createThread("Transient error");
    const store = session.watch(threadId);
    await session.send(threadId, `${tag} Go.`);
    const [turn] = await session.settled(store, 1);
    expect(turn!.state).toBe("complete");
    expect(turn!.assistant).toBe("Answered after retry.");
    // The tool ran once; the retry replays only the model step.
    expect(turn!.activities.filter((activity) => activity.kind === "tool")).toHaveLength(1);
    expectPairedToolCalls(e2e.model.forScenario("transient").at(-1)!.request.messages);
  }, 60_000);

  // Fails today: the provider's rejection message is replaced by "Unknown operation failure".
  test.failing(
    "a rejected request fails the turn visibly and the thread keeps working",
    async () => {
      const tag = e2e.model.script("rejected", (_request, model) => {
        if (model.lastUserText.includes("try again")) return { text: "Working again." };
        return {
          fault: {
            kind: "error",
            status: 400,
            code: "invalid_prompt",
            message: "Invalid prompt: rejected by the scripted provider.",
          },
        };
      });
      const threadId = await session.createThread("Rejected");
      const store = session.watch(threadId);
      await session.send(threadId, `${tag} Go.`);
      const [failedTurn] = await session.settled(store, 1);
      expect(failedTurn!.state).toBe("failed");
      expect(JSON.stringify(failedTurn!.messages)).toContain("rejected by the scripted provider");
      await session.send(threadId, `${tag} try again`);
      const turns = await session.settled(store, 2);
      expect(turns[1]!.assistant).toContain("Working again.");
    },
    60_000,
  );
});

describe("OpenAI Responses in auto transport", () => {
  let e2e: E2E;
  beforeAll(async () => {
    e2e = await startE2E({ provider: "responses-auto" });
  }, 60_000);
  afterAll(async () => {
    await e2e?.[Symbol.asyncDispose]();
    expect(e2e?.model.unhandled ?? []).toEqual([]);
  }, 60_000);

  test("a refused WebSocket upgrade falls back to SSE before submission", async () => {
    e2e.model.refuseUpgrades = true;
    const tag = e2e.model.script("auto-fallback", (_request, model) => {
      if (model.step === 0)
        return { toolCalls: [{ name: "bash", args: { command: "echo over-sse" } }] };
      return { text: "Done without WebSockets." };
    });
    const session = await e2e.session({ style: "web" });
    const threadId = await session.createThread("Auto fallback");
    const store = session.watch(threadId);
    await session.send(threadId, `${tag} Go.`);
    const [turn] = await session.settled(store, 1);
    expect(turn!.state).toBe("complete");
    expect(turn!.assistant).toContain("Done without WebSockets.");
    expect(e2e.model.forScenario("auto-fallback").map((entry) => entry.request.protocol)).toEqual([
      "responses-sse",
      "responses-sse",
    ]);
    expect(e2e.model.headers.some((headers) => headers.upgrade === "websocket")).toBe(true);
  }, 60_000);
});
