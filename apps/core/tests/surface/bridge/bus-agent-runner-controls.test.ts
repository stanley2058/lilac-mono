import { describe, expect, it } from "bun:test";
import { type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import { applyToRunningAgent } from "../../../src/surface/bridge/bus-agent-runner/controls";
import type {
  Enqueued,
  SessionQueue,
} from "../../../src/surface/bridge/bus-agent-runner/session-queue";
import { deferred, level1TextStep } from "./bus-agent-runner-test-support";

function countingAgent() {
  const calls = { count: 0 };
  const agent = new AiSdkPiAgent({
    system: "test",
    tools: {},
    model: new MockLanguageModelV4({
      modelId: "controls",
      doStream: async () => {
        calls.count += 1;
        return level1TextStep("done");
      },
    }),
  });
  return { agent, calls };
}

function controlEntry(queue: Enqueued["queue"], text: string): Enqueued {
  return {
    requestId: "request",
    queue,
    messages: [{ role: "user", content: text }],
    storedMessages: [{ role: "user", content: text }],
    raw: undefined,
  } as unknown as Enqueued;
}

function fakeActiveRun(
  materializeStoredMessages: (() => Promise<ModelMessage[]>) | null,
): SessionQueue["activeRun"] {
  return {
    flushOutput: () => undefined,
    materializeStoredMessages,
    rememberStoredMessages: () => undefined,
    setCurrentTurnContext: () => undefined,
    notifyWaiters: () => undefined,
    runProfile: "subagent",
  } as unknown as SessionQueue["activeRun"];
}

describe("applyToRunningAgent", () => {
  it("leaves the agent alone when its run ends while the control's messages load", async () => {
    const { agent, calls } = countingAgent();
    const materializing = deferred<void>();
    const release = deferred<void>();
    let current = true;
    const retained: string[] = [];
    const applied = applyToRunningAgent(
      agent,
      controlEntry("steer", "late steer"),
      new Set(),
      fakeActiveRun(async () => {
        materializing.resolve(undefined);
        await release.promise;
        return [{ role: "user", content: "late steer" }];
      }),
      (checkpoint) => retained.push(checkpoint.kind),
      (operation) => void operation(),
      { isCurrent: () => current, dropEnded: async () => undefined },
    );
    await materializing.promise;
    current = false;
    release.resolve(undefined);

    const outcome = await applied;
    await agent.waitForIdle();
    expect(calls.count).toBe(0);
    expect(retained).toEqual([]);
    expect(outcome).toBe("target-ended");
  });

  it("drops a deferred idle interrupt whose run ended before it ran", async () => {
    const { agent, calls } = countingAgent();
    let current = true;
    let dropped = 0;
    const retained: string[] = [];
    const pending: { operation?: () => Promise<void> } = {};
    const applied = await applyToRunningAgent(
      agent,
      controlEntry("interrupt", "late interrupt"),
      new Set(),
      fakeActiveRun(null),
      (checkpoint) => retained.push(checkpoint.kind),
      (operation) => {
        pending.operation = operation;
      },
      {
        isCurrent: () => current,
        dropEnded: async () => {
          dropped += 1;
        },
      },
    );
    current = false;
    expect(pending.operation).toBeDefined();
    await pending.operation?.();
    await agent.waitForIdle();

    expect(calls.count).toBe(0);
    expect(retained).toEqual([]);
    expect(dropped).toBe(1);
    expect(applied).toBe("applied");
  });
});
