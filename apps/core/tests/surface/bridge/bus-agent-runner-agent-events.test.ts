import { describe, expect, it } from "bun:test";
import { type ModelMessage } from "ai";
import {
  consumeAssistantTextDelta,
  consumeReasoningChunkEvent,
  type ReasoningChunkState,
  createAssistantTextPartBoundaryState,
  markAssistantTextPartEnded,
  markAssistantTextPartStarted,
  removeSilentAssistantTurnMessages,
  withBlankLineBetweenTextParts,
} from "../../../src/surface/bridge/bus-agent-runner";
import { useTestBlobStore } from "./bus-agent-runner-test-support";

useTestBlobStore();

describe("reasoning chunk streaming", () => {
  it("publishes accumulated snapshots before thinking_end without duplicating on end", () => {
    const state = { chunks: new Map<string, string>(), seq: 0 };

    expect(
      consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "reasoning-1",
        delta: "",
      }),
    ).toEqual({ publishStart: true, snapshot: null });
    expect(
      consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "reasoning-1",
        delta: "**Inspecting**",
      }),
    ).toEqual({
      publishStart: false,
      snapshot: { delta: "**Inspecting**", seq: 1 },
    });
    expect(
      consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "reasoning-1",
        delta: "\n\nChecking the stream.",
      }),
    ).toEqual({
      publishStart: false,
      snapshot: { delta: "**Inspecting**\n\nChecking the stream.", seq: 2 },
    });
    expect(
      consumeReasoningChunkEvent(state, {
        type: "end",
        chunkId: "reasoning-1",
      }),
    ).toEqual({
      publishStart: false,
      snapshot: null,
    });
    expect(state.chunks.has("reasoning-1")).toBe(false);
  });
});

describe("reasoning snapshot cap", () => {
  it("caps published snapshots at the relay limit and keeps the full chunk", () => {
    const state: ReasoningChunkState = { chunks: new Map(), seq: 0 };
    consumeReasoningChunkEvent(state, { type: "start", chunkId: "r" });
    let snapshot: { delta: string; seq: number } | null = null;
    for (let index = 0; index < 50; index += 1) {
      snapshot = consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "r",
        delta: "x".repeat(200),
      }).snapshot;
    }
    expect(state.chunks.get("r")).toHaveLength(10_000);
    expect(snapshot?.delta).toHaveLength(4_001);
    expect(snapshot?.seq).toBe(50);
  });
});

describe("withBlankLineBetweenTextParts", () => {
  it("adds a blank line when text part id changes", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\n\nPart two.");
  });

  it("extends an existing trailing newline to a blank line", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not duplicate existing blank-line separation", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("Part two.");
  });

  it("keeps provider whitespace when delta already starts with whitespace", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "\nPart two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not change deltas when part did not change", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: false,
    });

    expect(out).toBe("Part two.");
  });

  it("supports restart recovery boundaries with prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Sure! Triggering now - see you on the other side.",
      delta: "...and I'm back.",
      partChanged: true,
    });

    expect(out).toBe("\n\n...and I'm back.");
  });

  it("does not add separator when there is no prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "",
      delta: "Fresh reply.",
      partChanged: true,
    });

    expect(out).toBe("Fresh reply.");
  });
});

describe("silent assistant turn removal", () => {
  it("drops pure assistant output only inside the completed turn range", () => {
    const messages = [
      { role: "user", content: "request" },
      { role: "assistant", content: "NO_REPLY" },
      { role: "assistant", content: "later answer" },
    ] satisfies ModelMessage[];

    expect(
      removeSilentAssistantTurnMessages({
        messages,
        startIndex: 1,
        messageCount: 1,
      }),
    ).toEqual([messages[0]!, messages[2]!]);
  });

  it("removes sentinel text but preserves structural assistant parts", () => {
    const messages = [
      { role: "user", content: "request" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "NO_REPLY" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "builtin",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "builtin",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] satisfies ModelMessage[];

    expect(
      removeSilentAssistantTurnMessages({
        messages,
        startIndex: 1,
        messageCount: 1,
      }),
    ).toEqual([
      messages[0]!,
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "builtin",
            input: {},
          },
        ],
      },
      messages[2]!,
    ]);
  });

  it("drops reasoning when no structural assistant parts remain", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "NO_REPLY" },
        ],
      },
    ] satisfies ModelMessage[];

    expect(
      removeSilentAssistantTurnMessages({
        messages,
        startIndex: 0,
        messageCount: 1,
      }),
    ).toEqual([]);
  });

  it("uses final-answer phase text when commentary precedes the sentinel", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Commentary update.",
            providerOptions: { openai: { phase: "commentary" } },
          },
          {
            type: "text",
            text: "NO_REPLY",
            providerOptions: { openai: { phase: "final_answer" } },
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "builtin",
            input: {},
          },
        ],
      },
    ] satisfies ModelMessage[];

    expect(
      removeSilentAssistantTurnMessages({
        messages,
        startIndex: 0,
        messageCount: 1,
      }),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "builtin",
            input: {},
          },
        ],
      },
    ]);
  });
});

describe("assistant text part boundary accumulation", () => {
  it("separates streamed output and final text when a resumed text block reuses the same part id", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const secondDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(secondDelta);
    finalText += secondDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const thirdDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Now let me update the discovery.search entry...",
    });
    streamed.push(thirdDelta);
    finalText += thirdDelta;

    expect(streamed).toEqual([
      "...update the notes.",
      "\n\nWorks without the old patch...",
      "\n\nNow let me update the discovery.search entry...",
    ]);
    expect(finalText).toBe(
      "...update the notes.\n\nWorks without the old patch...\n\nNow let me update the discovery.search entry...",
    );
  });

  it("separates resumed streamed output from recovered visible text before persistence", () => {
    const state = createAssistantTextPartBoundaryState("Done. Updated TOOLS.md...");
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const delta = consumeAssistantTextDelta({
      state,
      finalText,
      recoveryPartialText: "Done. Updated TOOLS.md...",
      partId: "text-0",
      delta: "Now let me also write a daily note...",
    });
    streamed.push(delta);
    finalText += delta;

    expect(streamed).toEqual(["\n\nNow let me also write a daily note..."]);
    expect(finalText).toBe("\n\nNow let me also write a daily note...");
  });

  it("keeps a new text-block boundary pending across whitespace-only deltas", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const whitespaceDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "\n",
    });
    streamed.push(whitespaceDelta);
    finalText += whitespaceDelta;

    const textDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(textDelta);
    finalText += textDelta;

    expect(streamed).toEqual(["...update the notes.", "\n", "\nWorks without the old patch..."]);
    expect(finalText).toBe("...update the notes.\n\nWorks without the old patch...");
  });
});
