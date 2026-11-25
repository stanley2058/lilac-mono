import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Result, type Result as ResultType } from "better-result";

import {
  RESOURCE_MAX_BYTES,
  type MaterializedResource,
  type ResourceDescriptor,
} from "../../src/resource/contracts";
import {
  ResourceCacheUnavailable,
  ResourceCancelled,
  ResourceIntegrityFailure,
  ResourceTooLarge,
  type ResourceAccessError,
} from "../../src/resource/errors";
import type {
  ResourceAccess,
  ResourceOpenOptions,
  VerifiedResourceRead,
} from "../../src/resource/service";
import type { ResourceClassification } from "../../src/resource/resource-mime";
import { fsTool } from "../../src/tools/fs/fs";

const URI = "resource://r1_00000000000000000000000000000000";

type ResourceFixture = {
  readonly access: ResourceAccess;
  readonly opens: ResourceOpenOptions[];
};

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
  if (!isAsyncIterable<T>(value)) return await value;
  let last: T | undefined;
  for await (const chunk of value) last = chunk;
  if (last === undefined) throw new Error("AsyncIterable tool execute produced no values");
  return last;
}

function resourceFixture(params: {
  readonly bytes: Uint8Array;
  readonly classification: ResourceClassification;
  readonly filename?: string;
  readonly declaredMediaType?: string;
  readonly detectedMediaType?: string;
  readonly omitReportedByteLength?: boolean;
  readonly terminalError?: ResourceAccessError;
}): ResourceFixture {
  const descriptor: ResourceDescriptor = {
    uri: URI,
    ...(params.filename ? { filename: params.filename } : {}),
    ...(params.declaredMediaType ? { declaredMediaType: params.declaredMediaType } : {}),
    ...(params.detectedMediaType ? { detectedMediaType: params.detectedMediaType } : {}),
    ...(params.omitReportedByteLength ? {} : { reportedByteLength: params.bytes.byteLength }),
  };
  const sha256 = createHash("sha256").update(params.bytes).digest("hex");
  const opens: ResourceOpenOptions[] = [];

  const access: ResourceAccess = {
    describe: () => Result.ok(descriptor),
    async open(_uri, options) {
      opens.push(options);
      if (params.bytes.byteLength > options.maxBytes) {
        return Result.err(
          new ResourceTooLarge({
            uri: URI,
            limit: options.maxBytes,
            limitKind: "operation",
            reportedBytes: params.bytes.byteLength,
            message: `Resource exceeds the ${options.maxBytes}-byte limit`,
          }),
        );
      }
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < params.bytes.byteLength; offset += 2) {
        chunks.push(params.bytes.slice(offset, offset + 2));
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      const completion: VerifiedResourceRead["completion"] = Promise.resolve(
        params.terminalError
          ? Result.err(params.terminalError)
          : Result.ok({ sha256, byteLength: params.bytes.byteLength }),
      );
      return Result.ok({
        descriptor,
        classification: params.classification,
        blob: {
          version: 1,
          objectId: "b1_00000000000000000000000000000000",
          sha256,
          byteLength: params.bytes.byteLength,
        },
        stream,
        completion,
      });
    },
    async materialize(): Promise<ResultType<MaterializedResource, ResourceAccessError>> {
      return Result.err(
        new ResourceCacheUnavailable({
          uri: URI,
          retryable: false,
          message: "not used by this test",
        }),
      );
    },
  };
  return { access, opens };
}

function textFixture(
  text: string,
  options: { readonly terminalError?: ResourceAccessError } = {},
): ResourceFixture {
  return resourceFixture({
    bytes: new TextEncoder().encode(text),
    classification: { kind: "text", mediaType: "text/plain", encoding: "utf-8" },
    filename: "notes.txt",
    declaredMediaType: "text/plain",
    terminalError: options.terminalError,
  });
}

describe("resource-aware filesystem tools", () => {
  let baseDir: string;
  let grepTempRoot: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(tmpdir(), "lilac-resource-fs-"));
    grepTempRoot = path.join(baseDir, "grep-temp");
    await fs.mkdir(grepTempRoot);
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("streams resource text with normal paging and no filesystem instruction loading", async () => {
    await fs.writeFile(path.join(baseDir, "AGENTS.md"), "do not load me");
    const fixture = textFixture("\ufeffalpha\nbeta😀\ngamma");
    const read = fsTool(baseDir, {
      experimentalHashlineEdit: true,
      resourceAccess: fixture.access,
    }).read;

    const output = await read.execute!(
      {
        path: URI,
        start: { type: "line", line: 2, column: 1 },
        maxLines: 1,
        maxCharacters: 3,
        format: "numbered",
      },
      { toolCallId: "resource-text", messages: [], context: {} },
    );

    expect(output).toMatchObject({
      success: true,
      resolvedPath: URI,
      format: "raw",
      content: "eta",
      startLine: 2,
      hasMoreLines: true,
      nextStart: { type: "line", line: 2, column: 4 },
    });
    expect(output).not.toHaveProperty("loadedInstructions");
    expect(fixture.opens).toHaveLength(1);
  });

  it("rejects resource hashline reads before opening the resource", async () => {
    const fixture = textFixture("alpha\n");
    const read = fsTool(baseDir, {
      experimentalHashlineEdit: true,
      resourceAccess: fixture.access,
    }).read;
    const output = await read.execute!({ path: URI, format: "hashline" } as never, {
      toolCallId: "resource-hashline",
      messages: [],
      context: {},
    });

    expect(output).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("unavailable for resource://") },
    });
    expect(fixture.opens).toHaveLength(0);
  });

  it("allows resource reads before the restricted filesystem guard", async () => {
    const fixture = textFixture("restricted resource");
    const read = fsTool(baseDir, {
      artifactOnly: true,
      resourceAccess: fixture.access,
    }).read;
    const resource = await read.execute!(
      { path: URI },
      { toolCallId: "restricted-resource", messages: [], context: {} },
    );
    const local = await read.execute!(
      { path: path.join(baseDir, "local.txt") },
      { toolCallId: "restricted-local", messages: [], context: {} },
    );

    expect(resource).toMatchObject({ success: true, content: "restricted resource" });
    expect(local).toMatchObject({ success: false, error: { code: "PERMISSION" } });
  });

  it("returns verified resource images through the existing attachment model path", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
      "base64",
    );
    const fixture = resourceFixture({
      bytes,
      classification: { kind: "image", mediaType: "image/png" },
      filename: "pixel.png",
      declaredMediaType: "image/png",
    });
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
      maxInlineMediaBytesPerPart: 1_024,
      resourceAccess: fixture.access,
    }).read;
    const output = await resolveExecuteResult(
      read.execute!({ path: URI }, { toolCallId: "resource-image", messages: [], context: {} }),
    );
    const modelOutput = await read.toModelOutput!({
      toolCallId: "resource-image",
      input: { path: URI },
      output,
    });

    expect(output).toMatchObject({
      success: true,
      kind: "attachment",
      resolvedPath: URI,
      filename: "pixel.png",
      mimeType: "image/png",
      bytes: bytes.byteLength,
    });
    expect(modelOutput).toMatchObject({
      type: "content",
      value: expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          mediaType: "image/png",
          filename: "pixel.png",
          data: { type: "data", data: bytes.toString("base64") },
        }),
      ]),
    });
    expect(fixture.opens[0]?.maxBytes).toBe(1_024);
  });

  it("ignores declared media type when choosing the resource read policy", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
      "base64",
    );
    const fixture = resourceFixture({
      bytes,
      classification: { kind: "image", mediaType: "image/png" },
      filename: "upload",
      declaredMediaType: "application/pdf",
    });
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      maxInlineMediaBytesPerPart: 1_024,
      resourceAccess: fixture.access,
    }).read;

    const output = await resolveExecuteResult(
      read.execute!(
        { path: URI },
        { toolCallId: "resource-declared-mismatch", messages: [], context: {} },
      ),
    );

    expect(output).toMatchObject({
      success: true,
      kind: "attachment",
      mimeType: "image/png",
    });
    expect(fixture.opens[0]).toMatchObject({
      maxBytes: 1_024,
      expected: "any",
    });
  });

  it("accepts a PNG returned for a filename and declared WebP hint", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
      "base64",
    );
    const fixture = resourceFixture({
      bytes,
      classification: { kind: "image", mediaType: "image/png" },
      filename: "pixel.webp",
      declaredMediaType: "image/webp",
    });
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      maxInlineMediaBytesPerPart: 1_024,
      resourceAccess: fixture.access,
    }).read;

    const output = await resolveExecuteResult(
      read.execute!(
        { path: URI },
        { toolCallId: "resource-transformed-image", messages: [], context: {} },
      ),
    );

    expect(output).toMatchObject({
      success: true,
      kind: "attachment",
      filename: "pixel.webp",
      mimeType: "image/png",
    });
    expect(fixture.opens[0]).toMatchObject({
      maxBytes: 1_024,
      expected: "image",
    });
  });

  it("returns verified resource PDFs through the existing attachment model path", async () => {
    const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
    const fixture = resourceFixture({
      bytes,
      classification: { kind: "pdf", mediaType: "application/pdf" },
      filename: "document.pdf",
      declaredMediaType: "application/pdf",
    });
    const read = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
      resourceAccess: fixture.access,
    }).read;
    const output = await resolveExecuteResult(
      read.execute!({ path: URI }, { toolCallId: "resource-pdf", messages: [], context: {} }),
    );
    const modelOutput = await read.toModelOutput!({
      toolCallId: "resource-pdf",
      input: { path: URI },
      output,
    });

    expect(output).toMatchObject({
      success: true,
      kind: "attachment",
      mimeType: "application/pdf",
      filename: "document.pdf",
    });
    expect(modelOutput).toMatchObject({
      type: "content",
      value: expect.arrayContaining([
        expect.objectContaining({ type: "file", mediaType: "application/pdf" }),
      ]),
    });
  });

  it("attaches verified audio resources only for models with audio input", async () => {
    const fixture = () =>
      resourceFixture({
        bytes: new Uint8Array([1, 2, 3, 4]),
        classification: { kind: "binary", mediaType: "audio/ogg; codecs=opus" },
        filename: "voice.ogg",
        declaredMediaType: "audio/ogg",
      });
    const supported = fixture();
    const supportedOutput = await fsTool(baseDir, {
      readFileDirectAudioSupported: true,
      resourceAccess: supported.access,
    }).read.execute!({ path: URI }, { toolCallId: "audio", messages: [], context: {} });
    const unsupported = fixture();
    const unsupportedOutput = await fsTool(baseDir, {
      readFileDirectImageSupported: true,
      resourceAccess: unsupported.access,
    }).read.execute!({ path: URI }, { toolCallId: "audio-unsupported", messages: [], context: {} });

    expect(supportedOutput).toMatchObject({
      success: true,
      kind: "attachment",
      mimeType: "audio/ogg",
      bytes: 4,
    });
    expect(unsupportedOutput).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("not supported text, image, or PDF content") },
    });
  });

  it("supports Claude-style image-only reads while rejecting PDFs", async () => {
    const image = resourceFixture({
      bytes: new Uint8Array([1, 2, 3]),
      classification: { kind: "image", mediaType: "image/png" },
      filename: "image.png",
      declaredMediaType: "image/png",
    });
    const imageRead = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: false,
      resourceAccess: image.access,
    }).read;
    const imageOutput = await imageRead.execute!(
      { path: URI },
      { toolCallId: "resource-image-only-image", messages: [], context: {} },
    );

    const pdf = resourceFixture({
      bytes: new Uint8Array([4, 5, 6]),
      classification: { kind: "pdf", mediaType: "application/pdf" },
      filename: "document.pdf",
      declaredMediaType: "application/pdf",
    });
    const pdfRead = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: false,
      resourceAccess: pdf.access,
    }).read;
    const pdfOutput = await pdfRead.execute!(
      { path: URI },
      { toolCallId: "resource-image-only-pdf", messages: [], context: {} },
    );

    expect(imageOutput).toMatchObject({
      success: true,
      kind: "attachment",
      mimeType: "image/png",
    });
    expect(pdfOutput).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("does not accept this file type") },
    });
  });

  it("preflights unknown-size media while preserving hinted text reads", async () => {
    const boundaryImage = resourceFixture({
      bytes: new Uint8Array(16),
      classification: { kind: "image", mediaType: "image/png" },
      filename: "boundary.png",
      declaredMediaType: "application/octet-stream",
      omitReportedByteLength: true,
    });
    const imageRead = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      maxInlineMediaBytesPerPart: 16,
      resourceAccess: boundaryImage.access,
    }).read;
    const imageOutput = await imageRead.execute!(
      { path: URI },
      { toolCallId: "resource-boundary-image", messages: [], context: {} },
    );

    const oversizedPdf = resourceFixture({
      bytes: new Uint8Array(17),
      classification: { kind: "pdf", mediaType: "application/pdf" },
      filename: "unknown-size.pdf",
      omitReportedByteLength: true,
    });
    const pdfRead = fsTool(baseDir, {
      readFileDirectPdfSupported: true,
      maxInlineMediaBytesPerPart: 16,
      resourceAccess: oversizedPdf.access,
    }).read;
    const pdfOutput = await pdfRead.execute!(
      { path: URI },
      { toolCallId: "resource-oversized-pdf", messages: [], context: {} },
    );

    const text = resourceFixture({
      bytes: new TextEncoder().encode("text larger than 16 bytes"),
      classification: { kind: "text", mediaType: "text/plain", encoding: "utf-8" },
      filename: "unknown-size.txt",
      omitReportedByteLength: true,
    });
    const textRead = fsTool(baseDir, {
      maxInlineMediaBytesPerPart: 16,
      resourceAccess: text.access,
    }).read;
    const textOutput = await textRead.execute!(
      { path: URI },
      { toolCallId: "resource-large-text", messages: [], context: {} },
    );

    const binary = resourceFixture({
      bytes: new Uint8Array(17),
      classification: { kind: "binary", mediaType: "application/octet-stream" },
      filename: "unknown-size.bin",
      omitReportedByteLength: true,
    });
    const binaryRead = fsTool(baseDir, {
      maxInlineMediaBytesPerPart: 16,
      resourceAccess: binary.access,
    }).read;
    const binaryOutput = await binaryRead.execute!(
      { path: URI },
      { toolCallId: "resource-large-binary", messages: [], context: {} },
    );

    expect(imageOutput).toMatchObject({ success: true, kind: "attachment" });
    expect(boundaryImage.opens[0]?.maxBytes).toBe(16);
    expect(pdfOutput).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("16-byte media limit") },
    });
    expect(oversizedPdf.opens[0]?.maxBytes).toBe(16);
    expect(textOutput).toMatchObject({ success: true });
    expect(text.opens[0]?.maxBytes).toBe(RESOURCE_MAX_BYTES);
    expect(binaryOutput).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("resource.materialize") },
    });
    expect(binary.opens[0]?.maxBytes).toBe(16);
  });

  it("uses the inline ceiling for generic or absent MIME without a filename", async () => {
    const genericImage = resourceFixture({
      bytes: new Uint8Array(16),
      classification: { kind: "image", mediaType: "image/png" },
      declaredMediaType: "application/octet-stream",
      omitReportedByteLength: true,
    });
    const imageRead = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      maxInlineMediaBytesPerPart: 16,
      resourceAccess: genericImage.access,
    }).read;
    const imageOutput = await imageRead.execute!(
      { path: URI },
      { toolCallId: "resource-generic-image", messages: [], context: {} },
    );

    const unknownPdf = resourceFixture({
      bytes: new Uint8Array(16),
      classification: { kind: "pdf", mediaType: "application/pdf" },
      omitReportedByteLength: true,
    });
    const pdfRead = fsTool(baseDir, {
      readFileDirectPdfSupported: true,
      maxInlineMediaBytesPerPart: 16,
      resourceAccess: unknownPdf.access,
    }).read;
    const pdfOutput = await pdfRead.execute!(
      { path: URI },
      { toolCallId: "resource-unknown-pdf", messages: [], context: {} },
    );

    expect(imageOutput).toMatchObject({ success: true, kind: "attachment" });
    expect(genericImage.opens[0]?.maxBytes).toBe(16);
    expect(pdfOutput).toMatchObject({ success: true, kind: "attachment" });
    expect(unknownPdf.opens[0]?.maxBytes).toBe(16);
  });

  it("returns materialization guidance for binary resources and oversized media", async () => {
    const binary = resourceFixture({
      bytes: new Uint8Array([0, 1, 2]),
      classification: { kind: "binary", mediaType: "application/octet-stream" },
      filename: "archive.bin",
      declaredMediaType: "application/octet-stream",
    });
    const binaryRead = fsTool(baseDir, { resourceAccess: binary.access }).read;
    const unsupported = await binaryRead.execute!(
      { path: URI },
      { toolCallId: "resource-binary", messages: [], context: {} },
    );

    const oversized = resourceFixture({
      bytes: new Uint8Array(32),
      classification: { kind: "image", mediaType: "image/png" },
      filename: "large.png",
      declaredMediaType: "image/png",
    });
    const mediaRead = fsTool(baseDir, {
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
      maxInlineMediaBytesPerPart: 16,
      resourceAccess: oversized.access,
    }).read;
    const tooLarge = await mediaRead.execute!(
      { path: URI },
      { toolCallId: "resource-large", messages: [], context: {} },
    );

    expect(unsupported).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("resource.materialize") },
    });
    expect(tooLarge).toMatchObject({
      success: false,
      error: {
        message: expect.stringMatching(/16-byte media limit.*resource\.materialize/u),
      },
    });
  });

  it("reports terminal resource verification failures as read failures", async () => {
    const fixture = textFixture("untrusted", {
      terminalError: new ResourceIntegrityFailure({
        uri: URI,
        reason: "digest mismatch",
        message: "Resource bytes failed terminal verification",
      }),
    });
    const read = fsTool(baseDir, { resourceAccess: fixture.access }).read;
    const output = await read.execute!(
      { path: URI },
      { toolCallId: "resource-integrity", messages: [], context: {} },
    );

    expect(output).toMatchObject({
      success: false,
      resolvedPath: URI,
      error: { message: "Resource bytes failed terminal verification" },
    });
  });

  it("greps verified resource text through a private temporary file and removes it", async () => {
    const fixture = textFixture("alpha\nneedle here\nomega\n");
    const grep = fsTool(baseDir, {
      experimentalHashlineEdit: true,
      resourceAccess: fixture.access,
      resourceGrepTempRoot: grepTempRoot,
    }).grep;
    const output = await grep.execute!(
      { pattern: "needle", path: URI, mode: "detailed", fileExtensions: ["no-match"] },
      { toolCallId: "resource-grep", messages: [], context: {} },
    );

    expect(output).toMatchObject({
      mode: "detailed",
      truncated: false,
      results: [{ file: URI, line: 2, column: 1, text: "needle here\n" }],
    });
    expect(await fs.readdir(grepTempRoot)).toEqual([]);
  });

  it("rejects resource grep hashline mode without opening or staging", async () => {
    const fixture = textFixture("needle\n");
    const grep = fsTool(baseDir, {
      experimentalHashlineEdit: true,
      resourceAccess: fixture.access,
      resourceGrepTempRoot: grepTempRoot,
    }).grep;
    const output = await grep.execute!(
      { pattern: "needle", path: URI, mode: "hashline" },
      { toolCallId: "resource-grep-hashline", messages: [], context: {} },
    );

    expect(output).toMatchObject({
      mode: "hashline",
      error: expect.stringContaining("unavailable for resource://"),
    });
    expect(fixture.opens).toHaveLength(0);
    expect(await fs.readdir(grepTempRoot)).toEqual([]);
  });

  it("cleans resource grep staging after terminal verification failure", async () => {
    const fixture = textFixture("needle\n", {
      terminalError: new ResourceIntegrityFailure({
        uri: URI,
        reason: "digest mismatch",
        message: "Resource bytes failed terminal verification",
      }),
    });
    const grep = fsTool(baseDir, {
      resourceAccess: fixture.access,
      resourceGrepTempRoot: grepTempRoot,
    }).grep;
    const output = await grep.execute!(
      { pattern: "needle", path: URI },
      { toolCallId: "resource-grep-integrity", messages: [], context: {} },
    );

    expect(output).toMatchObject({
      mode: "default",
      results: [],
      error: "Resource bytes failed terminal verification",
    });
    expect(await fs.readdir(grepTempRoot)).toEqual([]);
  });

  it("cleans resource grep staging after cancellation", async () => {
    const fixture = textFixture("needle\n", {
      terminalError: new ResourceCancelled({
        uri: URI,
        message: "Resource read was cancelled",
      }),
    });
    const grep = fsTool(baseDir, {
      resourceAccess: fixture.access,
      resourceGrepTempRoot: grepTempRoot,
    }).grep;
    const output = await grep.execute!(
      { pattern: "needle", path: URI },
      { toolCallId: "resource-grep-cancelled", messages: [], context: {} },
    );

    expect(output).toMatchObject({ error: "Resource read was cancelled" });
    expect(await fs.readdir(grepTempRoot)).toEqual([]);
  });
});
