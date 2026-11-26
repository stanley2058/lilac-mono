import { describe, expect, it } from "bun:test";
import {
  DiscordOutputStream,
  escapeDiscordMarkdown,
} from "../../../../src/surface/discord/output/discord-output-stream";
import {
  resultValue,
  createFakeDiscordClient,
  hasFiles,
  contentFromOptions,
  embedDescriptionsFromOptions,
  filesCount,
  uploadedFileNames,
  allUploadedFileNames,
  makeAttachment,
} from "./discord-output-stream-fixture";

describe("plain flat table images", () => {
  const table = "| Name | State |\n| --- | --- |\n| Alpha | Ready |";
  const png = new Uint8Array([137, 80, 78, 71]);
  const defaults = {
    sessionRef: { platform: "discord", channelId: "chan" } as const,
    useSmartSplitting: true,
    outputMode: "preview" as const,
    outputPreviewModeFinalStyle: "plain" as const,
    outputPreviewModeFinalText: "flat" as const,
    markdownTableRender: { style: "image" as const, maxWidth: 50 },
    reasoningDisplayMode: "none" as const,
    workingIndicators: ["Working"],
  };

  it("renders only the final answer, uploads at table boundaries, and tracks every message", async () => {
    const { client, operations } = createFakeDiscordClient();
    let renders = 0;
    const seen: string[] = [];
    const out = new DiscordOutputStream({
      ...defaults,
      client,
      opts: {
        requestId: "table-request",
        replyTo: { platform: "discord", channelId: "chan", messageId: "source" },
        onMessageCreated: (ref) => {
          seen.push(ref.messageId);
        },
      },
      rewriteText: (text) => text.replaceAll("Alpha", "Rewritten"),
      renderTableImages: async (tables, context) => {
        expect(context).toEqual({ requestId: "table-request", channelId: "chan" });
        renders++;
        expect(tables).toHaveLength(2);
        expect(tables[0]?.rows[1]?.[0]?.runs).toEqual([{ text: "Rewritten" }]);
        return [png, png];
      },
    });
    const final = `Before\n\n${table}\n\nBetween\n\n${table}\n\nAfter`;
    await out.push({ type: "text.delta", phase: "commentary", delta: table });
    await out.push({
      type: "text.set",
      phase: "final_answer",
      text: table + final,
      finalSegments: [table, final],
    });
    expect(renders).toBe(0);
    const result = resultValue(await out.finish());
    expect(renders).toBe(1);
    const ids = result.created.map((ref) => ref.messageId);
    const sent = operations.filter((op) => ids.includes(op.messageId) && op.kind === "send");
    expect(sent.map((op) => contentFromOptions(op.options)?.trim())).toEqual([
      "Before",
      "Between",
      "After",
    ]);
    expect(sent.map((op) => uploadedFileNames(op.options))).toEqual([
      ["table-1.png"],
      ["table-2.png"],
      [],
    ]);
    const first = sent[0]?.options as {
      reply: { messageReference: string };
      files: { description?: string }[];
    };
    expect(first.reply.messageReference).toBe("source");
    expect(first.files[0]?.description).toBe(table.replaceAll("Alpha", "Rewritten"));
    expect((sent[1]!.options as { reply?: unknown }).reply).toBeUndefined();
    expect(ids.every((id) => seen.includes(id))).toBe(true);
    expect(result.last.messageId).toBe(ids.at(-1)!);
  });

  it("sends table-only answers without placeholder content", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      ...defaults,
      client,
      renderTableImages: async () => [png],
    });
    await out.push({ type: "text.delta", delta: table });
    const result = resultValue(await out.finish());
    const sent = operations.find(
      (op) => op.kind === "send" && op.messageId === result.last.messageId,
    );
    expect(contentFromOptions(sent?.options)).toBeUndefined();
    expect(uploadedFileNames(sent?.options)).toEqual(["table-1.png"]);
    expect(result.created).toHaveLength(1);
  });

  it("keeps ordinary attachments after a terminal table and respects the ten-file capacity", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      ...defaults,
      client,
      renderTableImages: async () => [png],
    });
    await out.push({ type: "text.delta", delta: table });
    for (let i = 0; i < 11; i++)
      await out.push({ type: "attachment.add", attachment: makeAttachment(i) });
    const result = resultValue(await out.finish());
    const sent = operations.filter(
      (op) => result.created.some((ref) => ref.messageId === op.messageId) && op.kind !== "edit",
    );
    expect(sent.map((op) => filesCount(op.options))).toEqual([1, 10, 1]);
    expect(allUploadedFileNames(sent)).toEqual([
      "table-1.png",
      ...Array.from({ length: 11 }, (_, i) => `image-${i}.png`),
    ]);
    expect(operations.filter((op) => op.kind === "edit" && hasFiles(op.options))).toHaveLength(0);
  });

  it("uses the text renderer when PNG rendering fails", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      ...defaults,
      client,
      renderTableImages: async () => [null],
    });
    await out.push({ type: "text.delta", delta: `Before\n\n${table}\n\nAfter` });
    const result = resultValue(await out.finish());
    const sent = operations.find(
      (op) => op.kind === "send" && op.messageId === result.last.messageId,
    );
    expect(contentFromOptions(sent?.options)).toContain("```text");
    expect(contentFromOptions(sent?.options)).toContain("┌");
    expect(contentFromOptions(sent?.options)).toContain("After");
    expect(uploadedFileNames(sent?.options)).toEqual([]);
  });

  it.each([
    { outputMode: "inline" as const },
    { outputPreviewModeFinalStyle: "embed" as const },
    { outputPreviewModeFinalText: "reply-chain" as const },
    { markdownTableRender: undefined },
  ])("does not render images outside enabled plain flat output: %j", async (override) => {
    const { client, operations } = createFakeDiscordClient();
    let renders = 0;
    const out = new DiscordOutputStream({
      ...defaults,
      ...override,
      client,
      renderTableImages: async () => {
        renders++;
        return [png];
      },
    });
    await out.push({ type: "text.delta", delta: table });
    const result = resultValue(await out.finish());
    expect(renders).toBe(0);
    if (override.markdownTableRender !== undefined || !("markdownTableRender" in override)) {
      const output = operations
        .filter((op) => result.created.some((ref) => ref.messageId === op.messageId))
        .flatMap((op) => [
          contentFromOptions(op.options) ?? "",
          ...embedDescriptionsFromOptions(op.options),
        ])
        .join("\n");
      expect(output).toContain("┌");
    }
  });

  it.each(["unicode", "ascii", undefined] as const)(
    "keeps style %s as text in plain flat mode",
    async (style) => {
      const { client, operations } = createFakeDiscordClient();
      let renders = 0;
      const out = new DiscordOutputStream({
        ...defaults,
        client,
        markdownTableRender: { style, maxWidth: 50 },
        renderTableImages: async () => {
          renders++;
          return [png];
        },
      });
      await out.push({ type: "text.delta", delta: `Before\n\n${table}\n\nAfter` });
      const result = resultValue(await out.finish());
      expect(renders).toBe(0);
      expect(result.created).toHaveLength(1);
      const sent = operations.find(
        (op) => op.kind === "send" && op.messageId === result.last.messageId,
      );
      const content = contentFromOptions(sent?.options);
      expect(content).toContain("Before");
      expect(content).toContain(style === "ascii" ? "+" : "┌");
      expect(content).toContain("After");
      expect(uploadedFileNames(sent?.options)).toEqual([]);
    },
  );
});

describe("escapeDiscordMarkdown", () => {
  it("escapes emphasis markers in glob-like patterns", () => {
    expect(escapeDiscordMarkdown("**/*")).toBe("\\*\\*/\\*");
  });

  it("escapes common markdown control characters", () => {
    expect(escapeDiscordMarkdown("[x](y) _z_ `k` ~u~")).toBe(
      "\\[x\\]\\(y\\) \\_z\\_ \\`k\\` \\~u\\~",
    );
  });
});

describe("discord blockquote normalization", () => {
  function getRenderedText(stream: DiscordOutputStream): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") {
      throw new Error("getRenderedText is unavailable");
    }
    return method.call(stream, "terminal") as string;
  }

  it("normalizes bare blockquote continuation lines before rendering", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    Reflect.set(out as object, "textAcc", "> first\n>\n> second");

    expect(getRenderedText(out)).toBe("> first\n> \n> second");
  });

  it("does not normalize bare markers inside fenced code in rendered text", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });
    const input = ["```md", ">", "```", ">"].join("\n");

    Reflect.set(out as object, "textAcc", input);

    expect(getRenderedText(out)).toBe(["```md", ">", "```", "> "].join("\n"));
  });
});

describe("experimental markdown table rendering", () => {
  const markdownTable = [
    "| Name | Score |",
    "| --- | ---: |",
    "| Alice | 10 |",
    "| Bob | 200 |",
  ].join("\n");

  function getRenderedText(stream: DiscordOutputStream): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") {
      throw new Error("getRenderedText is unavailable");
    }
    return method.call(stream, "terminal") as string;
  }

  it("rewrites markdown tables into fixed-width blocks when enabled", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownTableRender: {
        style: "unicode",
        maxWidth: 40,
      },
    });

    Reflect.set(out as object, "textAcc", markdownTable);

    const rendered = getRenderedText(out);
    expect(rendered).toContain("```text");
    expect(rendered).toContain("┌");
  });

  it("leaves markdown table text untouched when disabled", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    Reflect.set(out as object, "textAcc", markdownTable);

    const rendered = getRenderedText(out);
    expect(rendered).toBe(markdownTable);
  });
});

describe("Discord markdown math integration", () => {
  function getRenderedText(stream: DiscordOutputStream, phase: "streaming" | "terminal"): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") throw new Error("getRenderedText is unavailable");
    return method.call(stream, phase) as string;
  }

  function createMathStream(options?: {
    markdownMathRender?: { maxWidth?: number; fallbackMode?: "source" | "passthrough" };
    rewriteText?: (text: string) => string;
    markdownTableRender?: { style?: "unicode" | "ascii"; maxWidth?: number };
  }): DiscordOutputStream {
    const { client } = createFakeDiscordClient();
    return new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      ...options,
    });
  }

  it("renders inline and display math when enabled", () => {
    const out = createMathStream({ markdownMathRender: { maxWidth: 50 } });
    Reflect.set(out as object, "textAcc", "inline \\(x+1\\)\n\n$$y^2$$");

    expect(getRenderedText(out, "terminal")).toBe("inline `x + 1`\n\n```text\ny²\n```");
  });

  it("leaves math source byte-for-byte unchanged when options are omitted", () => {
    const out = createMathStream();
    const source = "inline \\(x+1\\)\r\n\r\n$$y^2$$";
    Reflect.set(out as object, "textAcc", source);

    expect(getRenderedText(out, "streaming")).toBe(source);
    expect(getRenderedText(out, "terminal")).toBe(source);
  });

  it("runs rewrite, blockquote normalization, tables, then math", () => {
    const out = createMathStream({
      rewriteText: () =>
        [">", "", "| Formula |", "| --- |", "| $$x+1$$ |", "", "outside \\(y+1\\)"].join("\n"),
      markdownTableRender: { style: "ascii", maxWidth: 40 },
      markdownMathRender: { maxWidth: 50 },
    });
    Reflect.set(out as object, "textAcc", "unrewritten \\(z\\)");

    const rendered = getRenderedText(out, "terminal");
    expect(rendered).toStartWith("> \n\n```text\n");
    expect(rendered).toContain("| $$x+1$$ |");
    expect(rendered).not.toContain("```text\nx + 1\n```");
    expect(rendered).toEndWith("outside `y + 1`");
    expect(rendered).not.toContain("unrewritten");
  });

  it("withholds incomplete math while streaming and restores it at terminal", () => {
    const out = createMathStream({ markdownMathRender: { fallbackMode: "passthrough" } });
    Reflect.set(out as object, "textAcc", "before \\(partial");

    expect(getRenderedText(out, "streaming")).toBe("before ");
    expect(getRenderedText(out, "terminal")).toBe("before \\(partial");
  });

  it("uses terminal rendering for the final embed-pusher sync", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownMathRender: { fallbackMode: "passthrough" },
    });

    await out.push({ type: "text.delta", delta: "before \\(partial" });
    await out.finish();

    const descriptions = operations.flatMap((operation) =>
      embedDescriptionsFromOptions(operation.options),
    );
    expect(descriptions.some((description) => description.includes("\\(partial"))).toBe(true);
    expect(descriptions.at(-1)).toBe("before \\(partial");
  });
});
