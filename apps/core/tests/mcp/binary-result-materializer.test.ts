import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CallToolResult } from "@ai-sdk/mcp";
import { z } from "zod";

import { createMcpBinaryResultMaterializer } from "../../src/mcp/binary-result-materializer";

const contentOutputSchema = z.object({
  type: z.literal("content"),
  value: z.array(z.unknown()),
});
const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

function digest(prefix: string, fill: string): string {
  return `${prefix}${fill.repeat(64)}`.slice(0, 64);
}

function noticeFrom(output: unknown): {
  mcpBinaryFiles: Array<{
    bytes: number;
    localPath: string;
    mediaType: string;
    source: string;
  }>;
  materializationFailures?: number;
} {
  const parsed = contentOutputSchema.parse(output);
  const noticePart = textPartSchema.parse(parsed.value.at(-1));
  return JSON.parse(noticePart.text.slice(noticePart.text.indexOf("\n") + 1));
}

describe("MCP binary result materialization", () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  async function createRoot(): Promise<string> {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-mcp-binary-test-"));
    return path.join(temporaryRoot, "lilac-mcp");
  }

  it("writes images and blob resources beside preserved inline model content", async () => {
    const rootDir = await createRoot();
    const materializer = createMcpBinaryResultMaterializer({
      requestId: "request-one",
      rootDir,
      hashId: (domain) => (domain === "request" ? digest("abcdef", "1") : digest("123456", "2")),
    });
    const inlineData = Buffer.from("png-content").toString("base64");
    const inline = {
      type: "file" as const,
      data: { type: "data" as const, data: inlineData },
      mediaType: "image/png",
    };

    const output = await materializer.project({
      toolCallId: "call-one",
      modelOutput: { type: "content", value: [inline] },
      output: {
        content: [
          { type: "image", data: inlineData, mimeType: "image/png" },
          {
            type: "resource",
            resource: {
              uri: "file:///report.pdf",
              blob: Buffer.from("pdf-content").toString("base64"),
              mimeType: "application/pdf",
            },
          },
        ],
      },
    });

    const parsed = contentOutputSchema.parse(output);
    expect(parsed.value[0]).toEqual(inline);
    const notice = noticeFrom(output);
    expect(notice).toEqual({
      mcpBinaryFiles: [
        {
          bytes: 11,
          localPath: path.join(rootDir, "req-abcdef", "call-123456", "0.png"),
          mediaType: "image/png",
          source: "image",
        },
        {
          bytes: 11,
          localPath: path.join(rootDir, "req-abcdef", "call-123456", "1.pdf"),
          mediaType: "application/pdf",
          source: "resource",
        },
      ],
    });
    expect(await fs.readFile(notice.mcpBinaryFiles[0]!.localPath, "utf8")).toBe("png-content");
    expect(await fs.readFile(notice.mcpBinaryFiles[1]!.localPath, "utf8")).toBe("pdf-content");
    expect((await fs.stat(path.join(rootDir, "req-abcdef"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(notice.mcpBinaryFiles[0]!.localPath)).mode & 0o777).toBe(0o600);
  });

  it("extends short hashes when request or call directories conflict", async () => {
    const rootDir = await createRoot();
    await fs.mkdir(rootDir, { mode: 0o700 });
    await fs.mkdir(path.join(rootDir, "req-abcdef"), { mode: 0o700 });
    const materializer = createMcpBinaryResultMaterializer({
      requestId: "request-collision",
      rootDir,
      hashId: (domain, id) => {
        if (domain === "request") return digest("abcdef12", "1");
        return id === "first-call" ? digest("123456aa", "2") : digest("123456bb", "3");
      },
    });
    const binaryOutput = {
      content: [
        {
          type: "image",
          data: Buffer.from("x").toString("base64"),
          mimeType: "image/png",
        },
      ],
    } satisfies CallToolResult;

    const first = noticeFrom(
      await materializer.project({
        toolCallId: "first-call",
        modelOutput: { type: "content", value: [] },
        output: binaryOutput,
      }),
    );
    const second = noticeFrom(
      await materializer.project({
        toolCallId: "second-call",
        modelOutput: { type: "content", value: [] },
        output: binaryOutput,
      }),
    );

    expect(first.mcpBinaryFiles[0]!.localPath).toBe(
      path.join(rootDir, "req-abcdef12", "call-123456", "0.png"),
    );
    expect(second.mcpBinaryFiles[0]!.localPath).toBe(
      path.join(rootDir, "req-abcdef12", "call-123456bb", "0.png"),
    );
  });

  it("leaves non-binary results unchanged without creating the root", async () => {
    const rootDir = await createRoot();
    const materializer = createMcpBinaryResultMaterializer({ requestId: "text-only", rootDir });
    const modelOutput = {
      type: "content" as const,
      value: [{ type: "text" as const, text: "hello" }],
    };

    expect(
      await materializer.project({
        toolCallId: "text-call",
        modelOutput,
        output: { content: [{ type: "text", text: "hello" }] },
      }),
    ).toBe(modelOutput);
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes content results that retain a legacy toolResult extension", async () => {
    const rootDir = await createRoot();
    const materializer = createMcpBinaryResultMaterializer({ requestId: "extended", rootDir });
    const data = Buffer.from("extended-content").toString("base64");

    const output = await materializer.project({
      toolCallId: "extended-call",
      modelOutput: { type: "content", value: [] },
      output: {
        content: [{ type: "image", data, mimeType: "image/png" }],
        toolResult: { retained: true },
      },
    });

    const [file] = noticeFrom(output).mcpBinaryFiles;
    expect(file?.localPath).toEndWith("/0.png");
    expect(await fs.readFile(file!.localPath, "utf8")).toBe("extended-content");
  });

  it("preserves inline content and reports a materialization failure", async () => {
    const rootDir = await createRoot();
    await fs.writeFile(rootDir, "not a directory");
    const materializer = createMcpBinaryResultMaterializer({ requestId: "failed", rootDir });
    const modelOutput = {
      type: "content" as const,
      value: [{ type: "text" as const, text: "inline remains" }],
    };

    const output = await materializer.project({
      toolCallId: "failed-call",
      modelOutput,
      output: {
        content: [
          {
            type: "image",
            data: Buffer.from("x").toString("base64"),
            mimeType: "image/png",
          },
        ],
      },
    });

    const parsed = contentOutputSchema.parse(output);
    expect(parsed.value[0]).toEqual(modelOutput.value[0]);
    expect(noticeFrom(output)).toEqual({ mcpBinaryFiles: [], materializationFailures: 1 });
  });
});
