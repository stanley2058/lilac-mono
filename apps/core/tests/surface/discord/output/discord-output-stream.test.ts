import { describe, expect, it } from "bun:test";
import {
  DiscordOutputStream,
  buildOutputAllowedMentions,
  buildWorkingTitle,
  clampReasoningDetail,
  formatReasoningAsBlockquote,
  sendDiscordStyledMessage,
  toPreviewTail,
} from "../../../../src/surface/discord/output/discord-output-stream";
import {
  resultValue,
  createFakeDiscordClient,
  contentFromOptions,
  hasEmbeds,
  embedDescriptionsFromOptions,
  embedFieldValuesFromOptions,
  filesCount,
  uploadedFileNames,
  makeAttachment,
} from "./discord-output-stream-fixture";

describe("styled message send", () => {
  const sessionRef = { platform: "discord" as const, channelId: "chan" };

  it("sends plain style as a content reply chain without a preview", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();

    const result = await sendDiscordStyledMessage({
      client,
      sessionRef,
      content: { text: "x".repeat(4500), style: "plain", attachments: [makeAttachment(1)] },
      opts: { replyTo: { platform: "discord", channelId: "chan", messageId: "origin" } },
      useSmartSplitting: false,
    });
    const last = resultValue(result);

    const created = operations.filter((op) => op.kind === "send" || op.kind === "reply");
    expect(created.map((op) => contentFromOptions(op.options)?.length)).toEqual([2000, 2000, 500]);
    expect(created.some((op) => hasEmbeds(op.options))).toBe(false);
    expect(created[0]?.options).toMatchObject({ reply: { messageReference: "origin" } });
    expect(created[1]?.parentId).toBe(created[0]?.messageId);
    expect(created[2]?.parentId).toBe(created[1]?.messageId);
    expect(uploadedFileNames(created[2]?.options)).toEqual(["image-1.png"]);
    expect(deletedMessageIds).toEqual([]);
    expect(created[2]?.messageId).toBe(last.messageId);
  });

  it("keeps embed style as the default", async () => {
    const { client, operations } = createFakeDiscordClient();

    resultValue(
      await sendDiscordStyledMessage({
        client,
        sessionRef,
        content: { text: "hello" },
        useSmartSplitting: false,
      }),
    );

    expect(operations.map((op) => embedDescriptionsFromOptions(op.options))).toContainEqual([
      "hello",
    ]);
    expect(operations.some((op) => contentFromOptions(op.options) === "hello")).toBe(false);
  });

  it("sends embed style directly without a streaming edit", async () => {
    const { client, operations } = createFakeDiscordClient();

    const last = resultValue(
      await sendDiscordStyledMessage({
        client,
        sessionRef,
        content: { text: "x".repeat(5000), attachments: [makeAttachment(1)] },
        opts: { replyTo: { platform: "discord", channelId: "chan", messageId: "origin" } },
        useSmartSplitting: false,
      }),
    );

    expect(operations.map((op) => op.kind)).toEqual(["send", "reply"]);
    expect(operations[0]?.options).toMatchObject({ reply: { messageReference: "origin" } });
    expect(operations.flatMap((op) => embedDescriptionsFromOptions(op.options)).join("")).toBe(
      "x".repeat(5000),
    );
    expect(uploadedFileNames(operations[1]?.options)).toEqual(["image-1.png"]);
    expect(last.messageId).toBe(operations[1]!.messageId);
  });
});

describe("preview final output style", () => {
  it("reposts phased final segments as a plain reply chain", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();
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

    await out.push({ type: "text.delta", delta: "Commentary.\n\nFinal answer." });
    await out.push({ type: "attachment.add", attachment: makeAttachment(9) });
    await out.push({
      type: "text.set",
      text: "Commentary.\n\nFinal answer.",
      finalSegments: ["Commentary.", "Final answer."],
    });
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (operation) =>
        (operation.kind === "send" || operation.kind === "reply") &&
        !hasEmbeds(operation.options) &&
        ["Commentary.", "Final answer."].includes(contentFromOptions(operation.options) ?? ""),
    );
    expect(plainFinalOps.map((operation) => contentFromOptions(operation.options))).toEqual([
      "Commentary.",
      "Final answer.",
    ]);
    expect(plainFinalOps[1]?.parentId).toBe(plainFinalOps[0]?.messageId);
    expect(filesCount(plainFinalOps[0]?.options)).toBe(0);
    expect(filesCount(plainFinalOps[1]?.options)).toBe(1);
    expect(deletedMessageIds.length).toBeGreaterThan(0);
    const finalPlainOperation = plainFinalOps[1];
    if (!finalPlainOperation) throw new Error("expected final plain segment");
    expect(res.last.messageId).toBe(finalPlainOperation.messageId);
  });

  it("renders each final segment in the terminal phase", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownMathRender: { fallbackMode: "passthrough" },
    });

    await out.push({
      type: "text.set",
      text: "combined",
      finalSegments: ["first \\(partial", "second \\(x+1\\)"],
    });
    await out.finish();

    const finalContents = operations
      .filter((operation) => operation.kind === "send" || operation.kind === "reply")
      .map((operation) => contentFromOptions(operation.options))
      .filter((content): content is string => content !== undefined);
    expect(finalContents).toContain("first \\(partial");
    expect(finalContents).toContain("second `x + 1`");
  });

  it("posts preview final output as content and stats as metadata when configured", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();

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

    await out.push({ type: "text.delta", delta: "preview text" });
    await out.push({ type: "meta.stats", line: "nerd stats" });
    const res = resultValue(await out.finish());

    const finalSend = operations.find(
      (op) =>
        op.kind === "send" &&
        contentFromOptions(op.options) === "preview text" &&
        hasEmbeds(op.options),
    );

    expect(finalSend).toBeDefined();
    if (!finalSend) {
      throw new Error("expected plain final send");
    }
    expect(contentFromOptions(finalSend.options)).not.toContain("nerd stats");
    expect(embedFieldValuesFromOptions(finalSend.options)).toEqual(["*nerd stats*"]);
    expect(deletedMessageIds.length).toBeGreaterThan(0);
    expect(res.last.messageId).toBe(finalSend.messageId);
  });

  it("attaches stats metadata only to the final plain preview chunk", async () => {
    const { client, operations } = createFakeDiscordClient();

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
    await out.push({ type: "meta.stats", line: "nerd stats" });
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (op) =>
        (op.kind === "send" || op.kind === "reply") &&
        (contentFromOptions(op.options)?.startsWith("x") ?? false),
    );

    expect(plainFinalOps.length).toBe(3);
    const lastPlainFinal = plainFinalOps[2];
    if (!lastPlainFinal) {
      throw new Error("expected third plain final chunk");
    }
    expect(contentFromOptions(plainFinalOps[0]?.options)?.length).toBe(2000);
    expect(contentFromOptions(plainFinalOps[1]?.options)?.length).toBe(2000);
    expect(contentFromOptions(lastPlainFinal.options)?.length).toBe(500);
    expect(hasEmbeds(plainFinalOps[0]?.options)).toBe(false);
    expect(hasEmbeds(plainFinalOps[1]?.options)).toBe(false);
    expect(embedFieldValuesFromOptions(lastPlainFinal.options)).toEqual(["*nerd stats*"]);
    expect(contentFromOptions(lastPlainFinal.options)).not.toContain("nerd stats");
    expect(res.last.messageId).toBe(lastPlainFinal.messageId);
  });

  it("splits plain preview final output into a normal reply chain", async () => {
    const { client, operations } = createFakeDiscordClient();

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
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (op) =>
        (op.kind === "send" || op.kind === "reply") &&
        !hasEmbeds(op.options) &&
        (contentFromOptions(op.options)?.startsWith("x") ?? false),
    );

    expect(plainFinalOps.length).toBe(3);
    const lastPlainFinal = plainFinalOps[2];
    if (!lastPlainFinal) {
      throw new Error("expected third plain final chunk");
    }
    expect(contentFromOptions(plainFinalOps[0]?.options)?.length).toBe(2000);
    expect(contentFromOptions(plainFinalOps[1]?.options)?.length).toBe(2000);
    expect(contentFromOptions(lastPlainFinal.options)?.length).toBe(500);
    expect(plainFinalOps[1]?.parentId).toBe(plainFinalOps[0]?.messageId);
    expect(plainFinalOps[2]?.parentId).toBe(plainFinalOps[1]?.messageId);
    expect(res.last.messageId).toBe(lastPlainFinal.messageId);
  });

  it("posts only the final answer as visually grouped plain messages", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();
    const commentary = "Commentary stays in the preview.";
    const finalAnswer = "F".repeat(4500);
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        replyTo: { platform: "discord", channelId: "chan", messageId: "source" },
      },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "flat",
      outputNotification: true,
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: commentary, phase: "commentary" });
    await out.push({ type: "text.delta", delta: finalAnswer, phase: "final_answer" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(9) });
    await out.push({
      type: "text.set",
      text: commentary + finalAnswer,
      phase: "final_answer",
      finalSegments: [commentary, finalAnswer],
    });
    const res = resultValue(await out.finish());

    const previewDescriptions = operations.flatMap((operation) =>
      embedDescriptionsFromOptions(operation.options),
    );
    expect(previewDescriptions.some((description) => description.includes(commentary))).toBe(true);
    expect(previewDescriptions.some((description) => description.includes("F".repeat(100)))).toBe(
      false,
    );

    const finalOps = operations.filter(
      (operation) => contentFromOptions(operation.options)?.startsWith("F") ?? false,
    );
    expect(finalOps.map((operation) => operation.kind)).toEqual(["send", "send", "send"]);
    expect(finalOps.map((operation) => contentFromOptions(operation.options)?.length)).toEqual([
      2000, 2000, 500,
    ]);
    expect(
      (finalOps[0]?.options as { reply?: { messageReference?: string } } | undefined)?.reply,
    ).toEqual({ messageReference: "source" });
    expect((finalOps[1]?.options as { reply?: unknown } | undefined)?.reply).toBeUndefined();
    expect((finalOps[2]?.options as { reply?: unknown } | undefined)?.reply).toBeUndefined();
    expect(
      (finalOps[0]?.options as { allowedMentions?: unknown } | undefined)?.allowedMentions,
    ).toEqual({ parse: ["users"], repliedUser: true });
    expect(
      (finalOps[1]?.options as { allowedMentions?: unknown } | undefined)?.allowedMentions,
    ).toEqual({ parse: ["users"], repliedUser: false });
    expect(
      (finalOps[2]?.options as { allowedMentions?: unknown } | undefined)?.allowedMentions,
    ).toEqual({ parse: ["users"], repliedUser: false });
    expect(filesCount(finalOps[0]?.options)).toBe(0);
    expect(filesCount(finalOps[1]?.options)).toBe(0);
    expect(filesCount(finalOps[2]?.options)).toBe(1);
    expect(
      operations.some(
        (operation) => contentFromOptions(operation.options)?.includes(commentary) ?? false,
      ),
    ).toBe(false);
    expect(deletedMessageIds.length).toBeGreaterThan(0);
    const lastFinalOp = finalOps[2];
    if (!lastFinalOp) throw new Error("expected third final plain message");
    expect(res.last.messageId).toBe(lastFinalOp.messageId);
  });
});

describe("reasoning display helpers", () => {
  function getReasoningPresentation(
    mode: "simple" | "detailed",
    detailText: string,
  ): { title: string; detail: string | null } {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: mode,
      workingIndicators: ["Working"],
    });
    Reflect.set(out as object, "hasReasoningStatus", true);
    Reflect.set(out as object, "reasoningDetailText", detailText);

    const getProgressTitle = Reflect.get(out as object, "getProgressTitle");
    const getReasoningValue = Reflect.get(out as object, "getReasoningValue");
    if (typeof getProgressTitle !== "function" || typeof getReasoningValue !== "function") {
      throw new Error("reasoning presentation methods are unavailable");
    }
    return {
      title: getProgressTitle.call(out) as string,
      detail: getReasoningValue.call(out) as string | null,
    };
  }

  it("keeps the working indicator and shows a detailed title-only summary", () => {
    const presentation = getReasoningPresentation("detailed", "**Inspecting the stream**");

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBe("> **Inspecting the stream**");
  });

  it("keeps the working indicator and blockquotes the full detailed summary", () => {
    const presentation = getReasoningPresentation(
      "detailed",
      "**Inspecting the stream**\n\nChecking event ordering.",
    );

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBe("> **Inspecting the stream**\n> \n> Checking event ordering.");
  });

  it("keeps the working indicator and hides the detail body in simple mode", () => {
    const presentation = getReasoningPresentation("simple", "**Inspecting the stream**");

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBeNull();
  });

  it("clamps long reasoning output and preserves leading content", () => {
    expect(clampReasoningDetail("0123456789", 4)).toBe("012…");
  });

  it("renders reasoning text as blockquote lines", () => {
    expect(formatReasoningAsBlockquote("**Title**\nline 1\nline 2")).toBe(
      "> **Title**\n> line 1\n> line 2",
    );
  });

  it("renders working title with elapsed request seconds", () => {
    expect(
      buildWorkingTitle({
        nowMs: 21_500,
        startedAtMs: 20_000,
        indicator: "Working",
      }),
    ).toBe("⣽ Working... 1s");
  });

  it("clamps reasoning detail body to 500 chars by default", () => {
    const detail = `${"a".repeat(520)}\n${"b".repeat(10)}`;
    const output = clampReasoningDetail(detail);
    expect(output.includes("…")).toBe(true);
    expect(output.length).toBe(500);
  });
});

describe("working indicator picker", () => {
  function getPicker(stream: DiscordOutputStream): (previous?: string) => string {
    const picker = Reflect.get(stream as object, "pickRandomWorkingIndicator");
    if (typeof picker !== "function") {
      throw new Error("pickRandomWorkingIndicator is unavailable");
    }
    return (previous?: string) => picker.call(stream, previous) as string;
  }

  it("cycles without immediate repeats for unique indicators", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Planning", "Reading", "Tooling"],
    });

    const pick = getPicker(out);
    let previous: string | undefined;

    for (let i = 0; i < 30; i++) {
      const next = pick(previous);
      if (previous) {
        expect(next).not.toBe(previous);
      }
      previous = next;
    }
  });

  it("reuses shuffled queue order across full cycles", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Planning", "Reading", "Tooling"],
    });

    const pick = getPicker(out);
    const cycleOne: string[] = [];
    const cycleTwo: string[] = [];

    let previous: string | undefined;
    for (let i = 0; i < 3; i++) {
      const next = pick(previous);
      cycleOne.push(next);
      previous = next;
    }

    for (let i = 0; i < 3; i++) {
      const next = pick(previous);
      cycleTwo.push(next);
      previous = next;
    }

    expect(new Set(cycleOne).size).toBe(3);
    expect(cycleTwo).toEqual(cycleOne);
  });
});

describe("preview tail helper", () => {
  it("returns input unchanged when already within limit", () => {
    expect(toPreviewTail("hello", 10)).toBe("hello");
  });

  it("tails to exact max length with ellipsis prefix", () => {
    const out = toPreviewTail("0123456789", 6);
    expect(out).toBe("...789");
    expect(out.length).toBe(6);
  });

  it("prefers a complete trailing block over a partial text tail", () => {
    expect(toPreviewTail("discarded text that is long\n\ncomplete block", 20, true)).toBe(
      "...complete block",
    );
  });
});

describe("output mention policy", () => {
  it("disables reply and mentions when notifications are off", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: false,
        previewMode: false,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("suppresses notifications on preview transient lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: false,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("enables user mentions and reply ping on preview final lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: ["users"], repliedUser: true });
  });
});
