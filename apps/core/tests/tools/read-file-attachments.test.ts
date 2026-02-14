import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-read-file-att-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns images as image-data tool-result content", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=";
    const pngBytes = Buffer.from(pngBase64, "base64");

    await writeFile(path.join(baseDir, "img.png"), pngBytes);

    const tools = fsTool(baseDir);
    const readFile = tools.read_file;

    expect(readFile.execute).toBeDefined();
    expect(readFile.toModelOutput).toBeDefined();

    const output = await resolveExecuteResult(
      readFile.execute!({ path: "img.png" }, { toolCallId: "t1", messages: [] }),
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
    expect(parts[1]!.type).toBe("image-data");
    if (parts[1]!.type !== "image-data") return;
    expect(parts[1]!.mediaType).toBe("image/png");
    expect(parts[1]!.data).toBe(pngBase64);
  });

  it("returns PDFs as file-data tool-result content", async () => {
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
      readFile.execute!({ path: "doc.pdf" }, { toolCallId: "t2", messages: [] }),
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
    expect(parts[1]!.type).toBe("file-data");
    if (parts[1]!.type !== "file-data") return;

    expect(parts[1]!.mediaType).toBe("application/pdf");
    expect(parts[1]!.filename).toBe("doc.pdf");
    expect(parts[1]!.data).toBe(pdf.toString("base64"));
  });
});
