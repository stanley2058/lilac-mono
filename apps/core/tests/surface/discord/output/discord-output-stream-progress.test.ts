import { describe, expect, it } from "bun:test";
import { Result } from "better-result";
import {
  DiscordOutputStream,
  buildDiscordProgressLines,
} from "../../../../src/surface/discord/output/discord-output-stream";
import type { SurfaceToolStatusUpdate } from "../../../../src/surface/adapter";
import { buildProgressFieldValue } from "../../../../src/surface/discord/output/embed-pusher";
import {
  resultValue,
  createFakeDiscordClient,
  contentFromOptions,
  embedDescriptionsFromOptions,
  embedFieldValuesFromOptions,
} from "./discord-output-stream-fixture";

describe("compact subagent progress", () => {
  function entry(
    toolCallId: string,
    updatedSeq: number,
    update: Omit<SurfaceToolStatusUpdate, "toolCallId">,
  ) {
    return { toolCallId, updatedSeq, update: { toolCallId, ...update } };
  }

  function visible(lines: readonly string[]): string[] {
    return lines.map((line) => line.replaceAll("\\", ""));
  }

  it("keeps detailed reasoning visible alongside all five action rows", () => {
    const value = buildProgressFieldValue({
      reasoningValue: "> **Inspecting**\n> reasoning detail",
      actionsValue: "action one\naction two\naction three\naction four\nagent one",
    });

    expect(value.split("\n")).toEqual([
      "> **Inspecting**",
      "> reasoning detail",
      "",
      "action one",
      "action two",
      "action three",
      "action four",
      "agent one",
    ]);
  });

  it("reserves three rows for one active agent and two for recent main actions", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("tool-1", 1, { status: "end", display: "glob src", ok: true }),
          entry("tool-2", 2, { status: "end", display: "grep auth", ok: true }),
          entry("tool-3", 3, { status: "start", display: "bash bun test" }),
          entry("tool-4", 4, { status: "start", display: "read failing.test.ts" }),
        ],
        subagents: [
          entry("agent-1", 5, {
            status: "update",
            display: [
              "subagent (general; claude-fable-5 [high]; 1/2 done)",
              "|- + read package.json",
              "`- > bash bunx tsc --noEmit",
            ].join("\n"),
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "▶ bash bun test",
      "▶ read failing.test.ts",
      "… general (cl...fable-5 [hi]; 1/2)",
      "|- + read package.json",
      "`- > bash bunx tsc --noEmit",
    ]);
  });

  it("shows one child row per active agent when two are visible", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "update",
            display: "subagent (general; gpt-5.6-sol [low]; 1/2 done)\n`- > bash bun test",
          }),
          entry("agent-2", 2, {
            status: "update",
            display: "subagent (explore; claude-fable-5 [medium]; 14/20 done)\n`- > batch (2/6)",
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "… explore (cl...fable-5 [md]; 14/20)",
      "`- > batch (2/6)",
      "… general (gpt-5.6-sol [lo]; 1/2)",
      "`- > bash bun test",
    ]);
  });

  it("moves completed agents into tool history while active agents stay at the bottom", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "update",
            display: "subagent (general; claude-fable-5 [high]; 12/13 done)\n`- > read src/a.ts",
          }),
          entry("agent-2", 2, {
            status: "update",
            display: "subagent (self; gpt-5.6-sol [medium]; 1/2 done)\n`- > patch src/b.ts",
          }),
          entry("agent-3", 3, {
            status: "update",
            display: "subagent (explore; grok-4.5 [xhigh]; 8/10 done)\n`- > batch (2/6)",
          }),
          entry("agent-4", 4, {
            status: "end",
            display: "subagent (explore; 3/3 done)",
            ok: true,
          }),
          entry("agent-5", 5, {
            status: "end",
            display: "subagent (general; 4/4 done)",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ explore (3/3)",
      "✓ general (4/4)",
      "… explore (grok-4.5 [xh]; 8/10; batch)",
      "… self (gpt-5.6-sol [md]; 1/2; patch)",
      "… general (cl...fable-5 [hi]; 12/13; read)",
    ]);
  });

  it("orders completed agents with tools by recency", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("tool-old", 1, { status: "end", display: "glob src", ok: true }),
          entry("tool-new", 3, { status: "end", display: "grep auth", ok: true }),
        ],
        subagents: [
          entry("agent-complete", 2, {
            status: "end",
            display: "subagent (general; gpt-5.6-sol [high]; 2/2 done)",
            ok: true,
          }),
          entry("agent-active", 4, {
            status: "update",
            display: "subagent (explore; gpt-5.6-sol [low]; 1/2 done)",
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ glob src",
      "✓ general (gpt-5.6-sol [hi]; 2/2)",
      "✓ grep auth",
      "… explore (gpt-5.6-sol [lo]; 1/2)",
    ]);
  });

  it("evicts completed agents naturally as newer tools fill the history", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: Array.from({ length: 5 }, (_, index) =>
          entry(`tool-${index}`, index + 2, {
            status: "end",
            display: `bash command-${index}`,
            ok: true,
          }),
        ),
        subagents: [
          entry("agent-complete", 1, {
            status: "end",
            display: "subagent (general; 2/2 done)",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ bash command-0",
      "✓ bash command-1",
      "✓ bash command-2",
      "✓ bash command-3",
      "✓ bash command-4",
    ]);
  });

  it("counts only active agents in subagent overflow", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-complete", 1, {
            status: "end",
            display: "subagent (general; resolved)",
            ok: true,
          }),
          ...Array.from({ length: 4 }, (_, index) =>
            entry(`agent-active-${index}`, index + 2, {
              status: "update",
              display: `subagent (explore; ${index + 1}/4 done)`,
            }),
          ),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ general (resolved)",
      "… explore (4/4)",
      "… explore (3/4)",
      "… explore (2/4) · +1 more",
    ]);
  });

  it("renders failed and cancelled agents as terminal tool history", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-failed", 1, {
            status: "end",
            display: "subagent (general; failed)",
            ok: false,
          }),
          entry("agent-cancelled", 2, {
            status: "end",
            display: "subagent (explore; cancelled)",
            ok: false,
          }),
        ],
      }),
    );

    expect(lines).toEqual(["✗ general (failed)", "✗ explore (cancelled)"]);
  });

  it("collapses a completed agent and omits unresolved effort", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "end",
            display:
              "subagent (explore; gpt-5.6-sol [provider-default]; 3/3 done)\n`- + bash bun test",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual(["✓ explore (gpt-5.6-sol; 3/3)"]);
  });

  it("uses the delegated profile while an agent is starting", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "start",
            display: "subagent_delegate (general) Investigate flaky tests",
          }),
        ],
      }),
    );

    expect(lines).toEqual(["▶ general (starting)"]);
  });

  it("counts multiline batch rows within the five-line budget", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("batch-1", 1, {
            status: "update",
            display: [
              "batch (3 tools; 2/3 done)",
              "|- ✓ read a.ts",
              "|- ✓ grep auth",
              "`- ▶ bash bun test",
            ].join("\n"),
          }),
        ],
        subagents: [
          entry("agent-1", 2, {
            status: "update",
            display: "subagent (general; gpt-5.6-sol [high]; 1/2 done)",
          }),
          entry("agent-2", 3, {
            status: "update",
            display: "subagent (self; gpt-5.6-sol [medium]; 1/2 done)",
          }),
          entry("agent-3", 4, {
            status: "update",
            display: "subagent (explore; gpt-5.6-sol [low]; 1/2 done)",
          }),
        ],
      }),
    );

    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 2)).toEqual(["… batch (3 tools; 2/3 done)", "`- ▶ bash bun test"]);
    expect(lines.slice(2).every((line) => line.includes("gpt-5.6-sol"))).toBe(true);
  });

  it("normalizes restored builtin prefixes without rewriting plugin or batch displays", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("read", 1, { status: "start", display: "read_file restored.ts" }),
          entry("plugin", 2, { status: "start", display: "read_file_plugin restored.ts" }),
          entry("batch", 3, {
            status: "update",
            display: "batch (1 tools)\n`- ▶ read_file restored.ts",
          }),
        ],
        subagents: [
          entry("agent", 4, {
            status: "update",
            display: "subagent (explore; 1/2 done)\n`- > apply_patch restored.ts",
          }),
        ],
      }),
    );

    expect(lines).toContain("▶ read_file_plugin restored.ts");
    expect(lines).toContain("… batch (1 tools)");
    expect(lines).toContain("`- ▶ read restored.ts");
    expect(lines).toContain("`- > patch restored.ts");
  });

  it("normalizes restored builtin names in compact subagent headers", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("one", 1, {
            status: "update",
            display: "subagent (explore; 1/2 done)\n`- > read_file one.ts",
          }),
          entry("two", 2, {
            status: "update",
            display: "subagent (general; 1/2 done)\n`- > apply_patch two.ts",
          }),
          entry("three", 3, {
            status: "update",
            display: "subagent (self; 1/2 done)\n`- > edit_file three.ts",
          }),
        ],
      }),
    );

    expect(lines.some((line) => line.includes("; read)"))).toBe(true);
    expect(lines.some((line) => line.includes("; patch)"))).toBe(true);
    expect(lines.some((line) => line.includes("; edit)"))).toBe(true);
  });
});

describe("Discord initial output", () => {
  it("sends substantive content directly with reply, cancel, and creation correlation", async () => {
    const { client, operations } = createFakeDiscordClient();
    let createdMessageId: string | undefined;
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        requestId: "discord:chan:request",
        replyTo: { platform: "discord", channelId: "chan", messageId: "source" },
        onMessageCreated: (ref) => {
          createdMessageId = ref.messageId;
        },
      },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await expect(out.push({ type: "text.delta", delta: "hello" })).resolves.toEqual(
      Result.ok("visible"),
    );

    expect(operations).toHaveLength(1);
    const first = operations[0]?.options as {
      content?: string;
      embeds?: unknown[];
      reply?: { messageReference?: string };
      components?: unknown[];
    };
    expect(first.content).toBeUndefined();
    expect(first.embeds).toHaveLength(1);
    expect(first.reply).toEqual({ messageReference: "source" });
    expect(first.components).toHaveLength(1);
    expect(createdMessageId).toBe("m_1");
    await out.finish();
  });

  it("edits a recovered output message instead of posting another reply", async () => {
    const { client, createdMessageIds, operations } = createFakeDiscordClient();
    const original = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });
    await original.push({ type: "text.delta", delta: "before crash" });
    const originalResult = resultValue(await original.finish());
    const operationsBeforeRecovery = operations.length;
    let recoveredMessageId: string | undefined;
    const recovered = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        requestId: "discord:chan:request",
        resumeAt: originalResult.last,
        onMessageCreated: (ref) => {
          recoveredMessageId = ref.messageId;
        },
      },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await recovered.push({ type: "text.delta", delta: "after recovery" });

    expect(createdMessageIds).toEqual(["m_1"]);
    expect(operations.slice(operationsBeforeRecovery)).toEqual([
      expect.objectContaining({ kind: "edit", messageId: "m_1" }),
    ]);
    expect(recoveredMessageId).toBe("m_1");
    expect(resultValue(await recovered.finish()).last).toEqual(originalResult.last);
  });

  it("posts a fresh message when the recovered output message is unavailable", async () => {
    const { client, createdMessageIds, operations } = createFakeDiscordClient({
      failResumeFetch: true,
    });
    const recovered = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        resumeAt: { platform: "discord", channelId: "chan", messageId: "missing" },
      },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await recovered.push({ type: "text.delta", delta: "after recovery" });

    expect(createdMessageIds).toEqual(["m_1"]);
    expect(operations[0]).toEqual(expect.objectContaining({ kind: "send", messageId: "m_1" }));
    await recovered.finish();
  });
});

describe("Discord compact progress integration", () => {
  it("moves a completed agent into history before newer tool activity", async () => {
    let resolveCompletedEdit: (options: unknown) => void = () => {};
    let resolveShiftedEdit: (options: unknown) => void = () => {};
    const completedEdit = new Promise<unknown>((resolve) => {
      resolveCompletedEdit = resolve;
    });
    const shiftedEdit = new Promise<unknown>((resolve) => {
      resolveShiftedEdit = resolve;
    });
    const { client, operations } = createFakeDiscordClient({
      onEdit: (options) => {
        const lines = embedFieldValuesFromOptions(options)
          .flatMap((value) => value.replaceAll("\\", "").split("\n"))
          .filter(Boolean);
        if (lines.some((line) => line.includes("✓ general")) && lines.length === 1) {
          resolveCompletedEdit(options);
        }
        const completedIndex = lines.findIndex((line) => line.includes("✓ general"));
        const newerToolIndex = lines.findIndex((line) => line.includes("▶ bash parent-check"));
        if (completedIndex >= 0 && newerToolIndex > completedIndex) {
          resolveShiftedEdit(options);
        }
      },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "update",
        display: "subagent (general; gpt-5.6-sol [high]; 1/2 done)\n`- > bash child-check",
      },
    });
    const activeLines = embedFieldValuesFromOptions(operations[0]?.options).join("\n");
    expect(operations[0]?.kind).toBe("send");
    expect(activeLines).toContain("general");
    expect(activeLines).toContain("1/2");

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "end",
        display: "subagent (general; resolved)",
        ok: true,
      },
    });
    const completedEditOptions = await completedEdit;
    expect(
      embedFieldValuesFromOptions(completedEditOptions).map((value) => value.replaceAll("\\", "")),
    ).toEqual(["✓ general (gpt-5.6-sol [hi]; 1/2)"]);

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "tool-1",
        status: "start",
        display: "bash parent-check",
      },
    });
    const shiftedEditOptions = await shiftedEdit;
    expect(
      embedFieldValuesFromOptions(shiftedEditOptions).map((value) => value.replaceAll("\\", "")),
    ).toEqual(["✓ general (gpt-5.6-sol [hi]; 1/2)\n▶ bash parent-check"]);
    await out.finish();
  });

  it("keeps agents in the Working field and removes progress on completion", async () => {
    let resolveStreamingEdit: (options: unknown) => void = () => {};
    const streamingEdit = new Promise<unknown>((resolve) => {
      resolveStreamingEdit = resolve;
    });
    const { client, operations } = createFakeDiscordClient({
      onEdit: (options) => {
        if (embedFieldValuesFromOptions(options).some((value) => value.includes("bash bun test"))) {
          resolveStreamingEdit(options);
        }
      },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    for (let index = 1; index <= 4; index++) {
      await out.push({
        type: "tool.status",
        update: {
          toolCallId: `tool-${index}`,
          status: "start",
          display: `bash command-${index}`,
        },
      });
    }
    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "update",
        display: [
          "subagent (general; claude-fable-5 [high]; 1/2 done)",
          "|- + read package.json",
          "`- > bash bun test",
        ].join("\n"),
      },
    });

    const streamingEditOptions = await streamingEdit;
    const streamingValues = embedFieldValuesFromOptions(streamingEditOptions).map((value) =>
      value.replaceAll("\\", ""),
    );
    expect(streamingValues).toHaveLength(1);
    expect(streamingValues[0]?.split("\n")).toEqual([
      "▶ bash command-3",
      "▶ bash command-4",
      "… general (cl...fable-5 [hi]; 1/2)",
      "|- + read package.json",
      "`- > bash bun test",
    ]);

    await out.finish();
    const finalEdit = operations.filter((operation) => operation.kind === "edit").at(-1);
    expect(embedFieldValuesFromOptions(finalEdit?.options)).toEqual([]);
  });
});

describe("preview reanchor behavior", () => {
  it("reports hidden reasoning as terminal without rendering it", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await expect(
      out.push({
        type: "reasoning.status",
        update: { startedAtMs: 1, detailText: "hidden" },
      }),
    ).resolves.toEqual(Result.ok("terminal"));
    expect(operations).toEqual([]);
  });

  it("keeps frozen placeholder lane messages on reanchor", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.abort("reanchor");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(out.getFinalTextMode()).toBe("full");
    expect(deletedMessageIds).toEqual([]);
  });

  it("keeps frozen placeholder lane messages on interrupt reanchor", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.abort("reanchor_interrupt");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(deletedMessageIds).toEqual([]);
  });

  it.each([
    ["reanchor", "*Steering...*"],
    ["reanchor_interrupt", "*Interrupted...*"],
  ] as const)("replaces the flat-mode placeholder on %s", async (reason, placeholder) => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "flat",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hidden final", phase: "final_answer" });
    await out.abort(reason);

    const finalEdit = operations.filter((operation) => operation.kind === "edit").at(-1);
    expect(contentFromOptions(finalEdit?.options)).toBe(placeholder);
    expect(contentFromOptions(finalEdit?.options)).not.toBe("*Replying...*");
  });

  it("reports continuation final text mode for inline streams", () => {
    const { client } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    expect(out.getFinalTextMode()).toBe("continuation");
  });
});

describe("output operation failures", () => {
  it("returns a classified failure when the first substantive send fails", async () => {
    const { client, createdMessageIds } = createFakeDiscordClient({ sendFailure: { status: 503 } });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    const result = await out.push({ type: "text.delta", delta: "hello" });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected first-send failure");
    expect(result.error).toMatchObject({
      _tag: "SurfaceUnavailable",
      operation: "push-output",
    });
    expect(createdMessageIds).toEqual([]);
  });

  it("does not finish successfully when embed synchronization fails", async () => {
    const { client } = createFakeDiscordClient({ editFailure: { status: 503 } });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    const result = await out.finish();
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected finish failure");
    expect(result.error).toMatchObject({
      _tag: "SurfaceOperationPartiallyCompleted",
      operation: "finish-output",
    });
  });

  it("continues streaming in a fresh message when the edited message was deleted", async () => {
    const { client, createdMessageIds, operations } = createFakeDiscordClient({
      editFailure: { code: 10_008, status: 404 },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    const result = resultValue(await out.finish());

    expect(createdMessageIds.length).toBeGreaterThan(1);
    expect(result.last.messageId).toBe(createdMessageIds.at(-1)!);
    const last = operations.filter((op) => op.messageId === result.last.messageId).at(-1);
    expect(embedDescriptionsFromOptions(last?.options)).toEqual(["hello"]);
  });

  it("keeps the preview when the final reply fails", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient({
      failSendAt: 2,
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    const result = await out.finish();

    expect(result.status).toBe("error");
    expect(createdMessageIds).toHaveLength(1);
    expect(deletedMessageIds).toEqual([]);
  });

  it("returns partial completion when a later final chunk fails", async () => {
    const replyFailure = Object.assign(new Error("reply unavailable"), { status: 503 });
    const { client } = createFakeDiscordClient({
      failReplyAt: 1,
      replyFailure,
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });
    const result = await out.finish();

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected finish failure");
    expect(result.error).toMatchObject({
      _tag: "SurfaceOperationPartiallyCompleted",
      operation: "finish-output",
      created: { platform: "discord", channelId: "chan" },
    });
  });
});
