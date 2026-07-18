import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { asSchema, type ToolModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";

import { batchTool } from "../../src/tools/batch";
import { fsTool } from "../../src/tools/fs/fs";

describe("read_file attachments", () => {
  let baseDir: string;

  function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return (
      !!value &&
      typeof value === "object" &&
      Symbol.asyncIterator in value &&
      typeof (value as any)[Symbol.asyncIterator] === "function"
    );
  }

  async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
    if (isAsyncIterable(value)) {
      let last: T | undefined;
      for await (const chunk of value) last = chunk;
      if (last === undefined) {
        throw new Error("AsyncIterable tool execute produced no values");
      }
      return last;
    }
    return await value;
  }

  function isAttachmentResult(output: unknown): output is { success: true; kind: "attachment" } {
    return (
      !!output &&
      typeof output === "object" &&
      (output as Record<string, unknown>)["success"] === true &&
      (output as Record<string, unknown>)["kind"] === "attachment"
    );
  }

  function getToolDescription(toolValue: unknown): string {
    if (!toolValue || typeof toolValue !== "object") {
      throw new Error("missing tool object");
    }

    const description = (toolValue as { description?: unknown }).description;
    if (typeof description !== "string") {
      throw new Error("missing tool description");
    }

    return description;
  }

  function getInputPropertyDescriptions(toolValue: unknown): Record<string, string | undefined> {
    if (!toolValue || typeof toolValue !== "object") {
      throw new Error("missing tool object");
    }

    const inputSchema = (toolValue as { inputSchema?: unknown }).inputSchema;
    const schema = asSchema(inputSchema as never).jsonSchema as {
      properties?: Record<string, { description?: string }>;
    };
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, property]) => [
        name,
        property.description,
      ]),
    );
  }

  function zeroUsage() {
    return {
      inputTokens: {
        total: 0,
        noCache: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: {
        total: 0,
        text: 0,
        reasoning: 0,
      },
    };
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-read-file-att-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("advertises direct image and PDF reads only when enabled", () => {
    const unsupportedDescription = getToolDescription(fsTool(baseDir).read_file);
    expect(unsupportedDescription).not.toContain("image");
    expect(unsupportedDescription).not.toContain("PDF");
    expect(unsupportedDescription).not.toContain("attachment");

    const supportedDescription = getToolDescription(
      fsTool(baseDir, { readFileDirectAttachmentSupported: true }).read_file,
    );
    expect(supportedDescription).toContain(
      "calling read_file attaches the original file to your context for native visual or document analysis",
    );
    expect(supportedDescription).toContain(
      "Call read_file first for an image or PDF path, either directly or as an independent batch child",
    );
    expect(supportedDescription).not.toContain("OCR");
    expect(supportedDescription).not.toContain("upstream provider");
  });

  it("describes native media paths and text-only options when enabled", () => {
    const unsupported = getInputPropertyDescriptions(fsTool(baseDir).read_file);
    expect(unsupported.path).not.toContain("images");
    expect(unsupported.path).not.toContain("PDFs");

    const supported = getInputPropertyDescriptions(
      fsTool(baseDir, { readFileDirectAttachmentSupported: true }).read_file,
    );
    expect(supported.path).toContain(
      "Supported images and PDFs are attached to your context for native visual or document analysis.",
    );
    expect(supported.start).toStartWith("Text files only.");
    expect(supported.maxLines).toStartWith("Text files only.");
    expect(supported.maxCharacters).toStartWith("Text files only.");
    expect(supported.format).toStartWith("Text files only.");
  });

  it("returns images as file tool-result content", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=";
    const pngBytes = Buffer.from(pngBase64, "base64");

    await writeFile(path.join(baseDir, "img.png"), pngBytes);

    const tools = fsTool(baseDir);
    const readFile = tools.read_file;

    expect(readFile.execute).toBeDefined();
    expect(readFile.toModelOutput).toBeDefined();

    const output = await resolveExecuteResult(
      readFile.execute!({ path: "img.png" }, { toolCallId: "t1", messages: [], context: {} }),
    );

    expect(isAttachmentResult(output)).toBe(true);
    if (!isAttachmentResult(output)) return;

    const modelOut = await readFile.toModelOutput!({
      toolCallId: "t1",
      input: { path: "img.png" },
      output,
    });

    expect(modelOut.type).toBe("content");
    if (modelOut.type !== "content") return;

    const parts = modelOut.value;
    expect(parts.length).toBe(2);
    expect(parts[1]!.type).toBe("file");
    if (parts[1]!.type !== "file") return;
    expect(parts[1]!.mediaType).toBe("image/png");
    expect(parts[1]!.filename).toBe("img.png");
    expect(parts[1]!.data).toEqual({ type: "data", data: pngBase64 });
  });

  it("returns PDFs as file tool-result content", async () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n",
      "utf8",
    );
    await writeFile(path.join(baseDir, "doc.pdf"), pdf);

    const tools = fsTool(baseDir);
    const readFile = tools.read_file;

    expect(readFile.execute).toBeDefined();
    expect(readFile.toModelOutput).toBeDefined();

    const output = await resolveExecuteResult(
      readFile.execute!({ path: "doc.pdf" }, { toolCallId: "t2", messages: [], context: {} }),
    );

    expect(isAttachmentResult(output)).toBe(true);
    if (!isAttachmentResult(output)) return;

    const modelOut = await readFile.toModelOutput!({
      toolCallId: "t2",
      input: { path: "doc.pdf" },
      output,
    });

    expect(modelOut.type).toBe("content");
    if (modelOut.type !== "content") return;

    const parts = modelOut.value;
    expect(parts.length).toBe(2);
    expect(parts[1]!.type).toBe("file");
    if (parts[1]!.type !== "file") return;

    expect(parts[1]!.mediaType).toBe("application/pdf");
    expect(parts[1]!.filename).toBe("doc.pdf");
    expect(parts[1]!.data).toEqual({ type: "data", data: pdf.toString("base64") });
  });

  it("returns image content through an expanded batch child result", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=";
    await writeFile(path.join(baseDir, "batched.png"), Buffer.from(pngBase64, "base64"));
    const tools: ToolSet = {} as ToolSet;
    Object.assign(tools, fsTool(baseDir));
    Object.assign(
      tools,
      batchTool({ defaultCwd: baseDir, getTools: () => tools, editingMode: "none" }),
    );
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "batch-media",
                toolName: "batch",
                input: JSON.stringify({
                  tool_calls: [{ tool: "read_file", parameters: { path: "batched.png" } }],
                }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
      ],
    });
    const agent = new AiSdkPiAgent({ system: "test", model, tools });

    await agent.prompt("read the image in a batch");

    const childResult = agent.state.messages.find(
      (message): message is ToolModelMessage =>
        message.role === "tool" &&
        message.content.some(
          (part) => part.type === "tool-result" && part.toolName === "read_file",
        ),
    );
    expect(childResult).toBeDefined();
    if (!childResult) return;
    const part = childResult.content.find(
      (candidate) => candidate.type === "tool-result" && candidate.toolName === "read_file",
    );
    expect(part?.type).toBe("tool-result");
    if (part?.type !== "tool-result") return;
    expect(part.output.type).toBe("content");
    if (part.output.type !== "content") return;
    expect(part.output.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          mediaType: "image/png",
          filename: "batched.png",
          data: { type: "data", data: pngBase64 },
        }),
      ]),
    );
  });

  it("rejects oversized images before attachment caching with resize guidance", async () => {
    await writeFile(path.join(baseDir, "large.png"), Buffer.alloc(32));
    const readFile = fsTool(baseDir, { maxInlineMediaBytesPerPart: 16 }).read_file;

    const output = await resolveExecuteResult(
      readFile.execute!(
        { path: "large.png" },
        { toolCallId: "large-image", messages: [], context: {} },
      ),
    );

    expect(output).toMatchObject({ success: false });
    if (!("error" in output)) return;
    expect(output.error.message).toContain("large.png");
    expect(output.error.message).toContain("image/png");
    expect(output.error.message).toContain("Resize or compress the image");
  });

  it("rejects oversized PDFs with file-reduction guidance", async () => {
    await writeFile(path.join(baseDir, "large.pdf"), Buffer.alloc(32));
    const readFile = fsTool(baseDir, { maxInlineMediaBytesPerPart: 16 }).read_file;

    const output = await resolveExecuteResult(
      readFile.execute!(
        { path: "large.pdf" },
        { toolCallId: "large-pdf", messages: [], context: {} },
      ),
    );

    expect(output).toMatchObject({ success: false });
    if (!("error" in output)) return;
    expect(output.error.message).toContain("large.pdf");
    expect(output.error.message).toContain("application/pdf");
    expect(output.error.message).toContain("Reduce or compress the file");
  });
});
