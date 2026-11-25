import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { asSchema } from "ai";
import { Result } from "better-result";

import { fsTool } from "../../src/tools/fs/fs";

describe("read attachments", () => {
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

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-read-file-att-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("advertises the direct-media branches only when enabled", () => {
    const unsupportedDescription = getToolDescription(fsTool(baseDir).read);
    expect(unsupportedDescription).not.toContain("image");
    expect(unsupportedDescription).not.toContain("PDF");
    expect(unsupportedDescription).not.toContain("attachment");

    const supportedDescription = getToolDescription(
      fsTool(baseDir, {
        readFileDirectImageSupported: true,
        readFileDirectPdfSupported: true,
      }).read,
    );
    expect(supportedDescription).toContain(
      "Analyze supported images and PDFs already attached to context directly",
    );
    expect(supportedDescription).toContain(
      "Use read to attach supported images and PDFs available only through a filesystem path or resource:// URI",
    );
    expect(supportedDescription).toContain(
      "If read reports unsupported or oversized media, use shell tools to create a supported file, then read that file",
    );
    expect(supportedDescription).not.toContain("OCR");
    expect(supportedDescription).not.toContain("upstream provider");

    const urlDescription = getToolDescription(
      fsTool(baseDir, {
        readFileDirectImageSupported: true,
        readFileDirectPdfSupported: true,
        readRemoteMedia: async () => Result.err(new Error("unused")),
      }).read,
    );
    expect(urlDescription).toContain("direct HTTP(S) URL");
    expect(urlDescription).toContain("Use fetch for web pages and text URLs");
  });

  it("keeps path syntax separate from media behavior", () => {
    const unsupported = getInputPropertyDescriptions(fsTool(baseDir).read);
    expect(unsupported.path).not.toContain("images");
    expect(unsupported.path).not.toContain("PDFs");

    const supported = getInputPropertyDescriptions(
      fsTool(baseDir, {
        readFileDirectImageSupported: true,
        readFileDirectPdfSupported: true,
      }).read,
    );
    expect(supported.path).toBe("Filesystem path or resource:// URI.");
    expect(supported.start).toStartWith("Text files only.");
    expect(supported.maxLines).toStartWith("Text files only.");
    expect(supported.maxCharacters).toStartWith("Text files only.");
    expect(supported.format).toStartWith("Text files only.");

    const imageOnlyDescription = getToolDescription(
      fsTool(baseDir, {
        readFileDirectImageSupported: true,
        readFileDirectPdfSupported: false,
      }).read,
    );
    expect(imageOnlyDescription).toContain("Analyze supported images already attached");
    expect(imageOnlyDescription).not.toContain("PDFs");

    const urlSupported = getInputPropertyDescriptions(
      fsTool(baseDir, {
        readFileDirectImageSupported: true,
        readRemoteMedia: async () => Result.err(new Error("unused")),
      }).read,
    );
    expect(urlSupported.path).toContain("HTTP(S) URL");
  });

  it("does not emit attachment output when the model lacks direct media support", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(baseDir, "unsupported.png"), png);
    const readFile = fsTool(baseDir).read;
    const output = await resolveExecuteResult(
      readFile.execute!(
        { path: "unsupported.png" },
        { toolCallId: "unsupported", messages: [], context: {} },
      ),
    );

    expect(isAttachmentResult(output)).toBe(false);
  });

  it("rejects mislabeled attachment content and preserves failure semantics", async () => {
    await writeFile(path.join(baseDir, "fake.png"), "not an image");
    const readFile = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
    }).read;
    const output = await resolveExecuteResult(
      readFile.execute!(
        { path: "fake.png" },
        { toolCallId: "fake-image", messages: [], context: {} },
      ),
    );
    expect(output).toMatchObject({ success: false });
    expect(JSON.stringify(output)).toContain("not a supported image or PDF");

    const modelOutput = await readFile.toModelOutput!({
      toolCallId: "fake-image",
      input: { path: "fake.png" },
      output,
    });
    expect(modelOutput).toMatchObject({ type: "error-json", value: { success: false } });
  });

  it("returns images as file tool-result content", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=";
    const pngBytes = Buffer.from(pngBase64, "base64");

    await writeFile(path.join(baseDir, "img.png"), pngBytes);

    const tools = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
    });
    const readFile = tools.read;

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

  function wavBytes(dataBytes = 0): Buffer {
    const u32 = (value: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32LE(value);
      return bytes;
    };
    return Buffer.concat([
      Buffer.from("RIFF"),
      u32(36 + dataBytes),
      Buffer.from("WAVEfmt "),
      u32(16),
      Buffer.from([1, 0, 1, 0]),
      u32(8000),
      u32(8000),
      Buffer.from([1, 0, 8, 0]),
      Buffer.from("data"),
      u32(dataBytes),
      Buffer.alloc(dataBytes),
    ]);
  }

  const mp4Bytes = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from("isomiso2"),
  ]);

  it("returns audio and video as file tool-result content when the model accepts them", async () => {
    await writeFile(path.join(baseDir, "voice.wav"), wavBytes());
    await writeFile(path.join(baseDir, "clip.mp4"), mp4Bytes);
    const readFile = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectAudioSupported: true,
      readFileDirectVideoSupported: true,
    }).read;

    expect(getToolDescription(readFile)).toContain(
      "Analyze supported images, audio, and video already attached to context directly",
    );
    for (const [file, mediaType] of [
      ["voice.wav", "audio/wav"],
      ["clip.mp4", "video/mp4"],
    ] as const) {
      const output = await resolveExecuteResult(
        readFile.execute!({ path: file }, { toolCallId: file, messages: [], context: {} }),
      );
      expect(output).toMatchObject({ success: true, kind: "attachment", mimeType: mediaType });
      const modelOut = await readFile.toModelOutput!({
        toolCallId: file,
        input: { path: file },
        output,
      });
      expect(modelOut).toMatchObject({
        type: "content",
        value: [{ type: "text" }, { type: "file", mediaType, filename: file }],
      });
    }
  });

  it("keeps models without video input from attaching local video", async () => {
    await writeFile(path.join(baseDir, "clip.mp4"), mp4Bytes);
    const readFile = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectAudioSupported: true,
    }).read;
    const output = await resolveExecuteResult(
      readFile.execute!({ path: "clip.mp4" }, { toolCallId: "video", messages: [], context: {} }),
    );
    expect(output).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("does not accept this file type") },
    });
  });

  it("keeps the 20 MB cap when attachment bytes are re-read for model output", async () => {
    await writeFile(path.join(baseDir, "grown.wav"), wavBytes(20_000_000));
    const readFile = fsTool(baseDir, {
      readFileDirectAudioSupported: true,
      maxInlineMediaBytesPerPart: 64 * 1024 * 1024,
    }).read;
    const modelOut = await readFile.toModelOutput!({
      toolCallId: "uncached",
      input: { path: "grown.wav" },
      output: {
        success: true,
        kind: "attachment",
        resolvedPath: path.join(baseDir, "grown.wav"),
        fileHash: "unused",
        filename: "grown.wav",
        mimeType: "audio/wav",
        bytes: 44,
      },
    });
    expect(modelOut).toMatchObject({
      type: "error-text",
      value: expect.stringContaining("20000000-byte media limit"),
    });
  });

  it("reads media-named text files normally for models without audio or video input", async () => {
    await writeFile(path.join(baseDir, "notes.ogg"), "plain text\n");
    const readFile = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
    }).read;
    const output = await resolveExecuteResult(
      readFile.execute!({ path: "notes.ogg" }, { toolCallId: "ogg", messages: [], context: {} }),
    );
    expect(output).toMatchObject({ success: true, content: "plain text\n" });
  });

  it("caps audio and video at 20 MB even when the per-part media limit is larger", async () => {
    await writeFile(path.join(baseDir, "long.wav"), wavBytes(20_000_000));
    const readFile = fsTool(baseDir, {
      readFileDirectAudioSupported: true,
      maxInlineMediaBytesPerPart: 64 * 1024 * 1024,
    }).read;
    const output = await resolveExecuteResult(
      readFile.execute!({ path: "long.wav" }, { toolCallId: "long", messages: [], context: {} }),
    );
    expect(output).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("20000000-byte media limit") },
    });
  });

  it("returns PDFs as file tool-result content", async () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n",
      "utf8",
    );
    await writeFile(path.join(baseDir, "doc.pdf"), pdf);

    const tools = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
    });
    const readFile = tools.read;

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

  it("drops retained URL attachment bytes when the call is aborted", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
      "base64",
    );
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readRemoteMedia: async () => Result.ok({ data: png }),
    }).read;
    const controller = new AbortController();
    const input = { path: "https://example.test/image.png" };
    const output = await resolveExecuteResult(
      read.execute!(input, {
        toolCallId: "aborted-image",
        messages: [],
        context: {},
        abortSignal: controller.signal,
      }),
    );
    expect(isAttachmentResult(output)).toBe(true);
    controller.abort();
    const model = await read.toModelOutput!({ toolCallId: "aborted-image", input, output });
    expect(model.type).toBe("error-text");
  });

  it("returns URL images through the existing attachment output", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=";
    const pngBytes = Buffer.from(pngBase64, "base64");
    const downloads: Array<{ url: string; maxBytes: number }> = [];
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
      maxInlineMediaBytesPerPart: 123_456,
      readRemoteMedia: async ({ url, maxBytes }) => {
        downloads.push({ url: url.toString(), maxBytes });
        return Result.ok({ data: pngBytes });
      },
    }).read;

    const inputUrl = "https://cdn.example.test/assets/photo?signature=secret";
    const output = await resolveExecuteResult(
      read.execute!({ path: inputUrl }, { toolCallId: "url-image", messages: [], context: {} }),
    );

    expect(downloads).toEqual([{ url: inputUrl, maxBytes: 123_456 }]);
    expect(output).toMatchObject({
      success: true,
      kind: "attachment",
      resolvedPath: "https://cdn.example.test/assets/photo",
      filename: "photo",
      mimeType: "image/png",
      bytes: pngBytes.byteLength,
    });
    if (!isAttachmentResult(output)) return;

    const modelOutput = await read.toModelOutput!({
      toolCallId: "url-image",
      input: { path: inputUrl },
      output,
    });
    expect(modelOutput).toMatchObject({
      type: "content",
      value: [
        { type: "text" },
        {
          type: "file",
          mediaType: "image/png",
          filename: "photo",
          data: { type: "data", data: pngBase64 },
        },
      ],
    });
  });

  it("does not let dangerouslyAllow bypass URL-read authority", async () => {
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
    }).read;

    const output = await resolveExecuteResult(
      read.execute!(
        { path: "https://example.test/image.png", dangerouslyAllow: true },
        { toolCallId: "url-denied", messages: [], context: {} },
      ),
    );

    expect(output).toMatchObject({
      success: false,
      error: { code: "PERMISSION", message: expect.stringContaining("web.fetch") },
    });
  });

  it("directs remote text and web pages back to fetch", async () => {
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readRemoteMedia: async () =>
        Result.ok({ data: Buffer.from("<html><body>hello</body></html>") }),
    }).read;

    const output = await resolveExecuteResult(
      read.execute!(
        { path: "https://example.test/page" },
        { toolCallId: "url-html", messages: [], context: {} },
      ),
    );

    expect(output).toMatchObject({
      success: false,
      error: { code: "UNKNOWN", message: expect.stringContaining("Use fetch") },
    });
  });

  it("keeps image-only models from attaching local PDFs", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(baseDir, "image.png"), png);
    await writeFile(path.join(baseDir, "document.pdf"), "%PDF-1.4\n%%EOF\n");
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: false,
    }).read;

    const image = await resolveExecuteResult(
      read.execute!(
        { path: "image.png" },
        { toolCallId: "image-only-image", messages: [], context: {} },
      ),
    );
    const pdf = await resolveExecuteResult(
      read.execute!(
        { path: "document.pdf" },
        { toolCallId: "image-only-pdf", messages: [], context: {} },
      ),
    );

    expect(image).toMatchObject({ success: true, kind: "attachment", mimeType: "image/png" });
    expect(pdf).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("does not accept this file type") },
    });
  });

  it("rejects oversized images before attachment caching with resize guidance", async () => {
    await writeFile(path.join(baseDir, "large.png"), Buffer.alloc(32));
    const readFile = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
      maxInlineMediaBytesPerPart: 16,
    }).read;

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
    const readFile = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
      maxInlineMediaBytesPerPart: 16,
    }).read;

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
