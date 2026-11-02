import { z } from "zod/v4";
import { fileTypeFromBuffer } from "file-type";
import fs from "node:fs/promises";
import { basename } from "node:path";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { isRecord } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";

import {
  defineServerTool,
  type RequestContext,
  type ServerTool,
  type ServerToolCallOptions,
} from "../types";
import {
  decodeToolServerHeaders,
  type RequiredToolServerHeaders,
} from "../../shared/tool-server-context";
import {
  formatToolPathForRequestContext,
  inferMimeTypeFromFilename,
  resolveToolPathForRequestContextResult,
} from "../../shared/attachment-utils";
import { preserveToolPanic } from "../../tools/tool-result-adapters";
import type { AttachmentOutputLifecycle } from "../../tools/attachment-output-lifecycle";
import {
  bindTransientResourceAccess,
  consumeVerifiedResourceRead,
  isCoreToolResultResourceUri,
  type ResourceAccess,
  type ResourceAccessError,
  type ScopedTransientResourceAccess,
} from "../../resource";
import type { ToolResultArtifactStore } from "../../artifacts/tool-result-artifact-store";
import { captureError, type CapturedError } from "../../shared/error-capture";

function attachmentFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `attachment_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

function attachmentFailureFromUnknown(cause: unknown, fallbackMessage: string): ServerToolFailure {
  if (Panic.is(cause)) preserveToolPanic(cause);
  const error = isRecord(cause) ? cause : {};
  const name = typeof error.name === "string" ? error.name : undefined;
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : fallbackMessage;
  if (name === "AbortError") return attachmentFailure("cancelled", message);
  if (name === "TimeoutError" || code === "ETIMEDOUT") {
    return attachmentFailure("timeout", message);
  }
  if (code === "ENOENT") return attachmentFailure("not_found", message);
  if (code === "EACCES" || code === "EPERM") {
    return attachmentFailure("denied", message);
  }
  return attachmentFailure("unavailable", message);
}

function attachmentFailureFromResource(error: ResourceAccessError): ServerToolFailure {
  switch (error._tag) {
    case "ResourceInvalidUri":
    case "ResourceTooLarge":
    case "ResourceUnsupportedClassification":
      return attachmentFailure("usage", error.message);
    case "ResourceNotFound":
      return attachmentFailure("not_found", error.message);
    case "ResourceAlreadyExists":
      return attachmentFailure("conflict", error.message);
    case "ResourceCancelled":
      return attachmentFailure("cancelled", error.message);
    case "ResourceOriginUnavailable":
    case "ResourceCacheUnavailable":
    case "ResourceIntegrityFailure":
    case "ResourceWriteFailed":
      return attachmentFailure("unavailable", error.message);
  }
}

function resultBranch<TValue>(
  result: ResultType<TValue, ServerToolFailure>,
): { readonly value: TValue } | { readonly failure: ServerToolFailure } {
  return result.match<{ readonly value: TValue } | { readonly failure: ServerToolFailure }>({
    ok: (value) => ({ value }),
    err: (failure) => ({ failure }),
  });
}

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

type RequestHeaders = RequiredToolServerHeaders;

const nonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

function normalizeAttachmentAddFilesInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const input = raw as Record<string, unknown>;
  if (input["paths"] !== undefined || input["files"] === undefined) {
    return raw;
  }

  return {
    ...input,
    paths: input["files"],
  };
}

function toHeaders(ctx: RequestContext | undefined): ResultType<RequestHeaders, ServerToolFailure> {
  return decodeToolServerHeaders(ctx, "attachment").mapError((error) =>
    attachmentFailure("usage", error.message),
  );
}

const attachmentAddFilesInputSchema = z
  .preprocess(
    normalizeAttachmentAddFilesInput,
    z.object({
      paths: nonEmptyStringListInputSchema.describe(
        "Local file paths or resource:// URIs to attach (paths resolve relative to request cwd; alias: files)",
      ),
      filenames: optionalNonEmptyStringListInputSchema.describe(
        "Optional filenames for each attachment",
      ),
      mimeTypes: optionalNonEmptyStringListInputSchema.describe(
        "Optional mime types for each attachment",
      ),
    }),
  )
  .describe("Add one or more attachments from local files or resources.");

type OutboundAttachmentSource = {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly mimeType?: string;
};

function captureAttachmentFileFailure(cause: unknown): CapturedError {
  return captureError(cause, "Attachment file read failed");
}

async function readLocalOutboundAttachment(input: {
  readonly path: string;
  readonly cwd: string;
  readonly context: RequestContext | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<ResultType<OutboundAttachmentSource, ServerToolFailure>> {
  const resolvedPathResult = resolveToolPathForRequestContextResult({
    cwd: input.cwd,
    inputPath: input.path,
    context: input.context,
  }).mapError((error) => attachmentFailure("denied", error.message));
  const resolvedPathBranch = resultBranch(resolvedPathResult);
  if ("failure" in resolvedPathBranch) return Result.err(resolvedPathBranch.failure);
  const resolvedPath = resolvedPathBranch.value;

  const stat = (
    await Result.tryPromise({
      try: () => fs.stat(resolvedPath),
      catch: captureAttachmentFileFailure,
    })
  ).mapError((failure) =>
    attachmentFailureFromUnknown(failure.cause, `Unable to read ${resolvedPath}`),
  );
  const statBranch = resultBranch(stat);
  if ("failure" in statBranch) return Result.err(statBranch.failure);
  const file = statBranch.value;
  if (!file.isFile()) {
    return Result.err(
      attachmentFailure(
        "usage",
        `Not a file: ${formatToolPathForRequestContext({ path: resolvedPath, context: input.context })}`,
      ),
    );
  }
  if (file.size > DEFAULT_OUTBOUND_MAX_FILE_BYTES) {
    return Result.err(
      attachmentFailure(
        "usage",
        `Attachment too large (${file.size} bytes). Max is ${DEFAULT_OUTBOUND_MAX_FILE_BYTES} bytes: ${formatToolPathForRequestContext({ path: resolvedPath, context: input.context })}`,
      ),
    );
  }

  const read = (
    await Result.tryPromise({
      try: () => fs.readFile(resolvedPath, input.signal ? { signal: input.signal } : {}),
      catch: captureAttachmentFileFailure,
    })
  ).mapError((failure) =>
    attachmentFailureFromUnknown(failure.cause, `Unable to read ${resolvedPath}`),
  );
  return read.map((bytes) => ({ bytes, filename: basename(resolvedPath) }));
}

async function readRetainedOutboundAttachment(input: {
  readonly uri: string;
  readonly resourceAccess: ResourceAccess | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<ResultType<OutboundAttachmentSource, ServerToolFailure>> {
  if (!input.resourceAccess) {
    return Result.err(attachmentFailure("unavailable", "Resource access is unavailable"));
  }

  const opened = (
    await input.resourceAccess.open(input.uri, {
      maxBytes: DEFAULT_OUTBOUND_MAX_FILE_BYTES,
      expected: "any",
      ...(input.signal ? { signal: input.signal } : {}),
    })
  ).mapError(attachmentFailureFromResource);
  const openedBranch = resultBranch(opened);
  if ("failure" in openedBranch) return Result.err(openedBranch.failure);
  const read = openedBranch.value;

  const consumed = (await consumeVerifiedResourceRead(read)).mapError(
    attachmentFailureFromResource,
  );
  return consumed.map((bytes) => ({
    bytes: Buffer.from(bytes),
    filename: read.descriptor.filename ?? "resource",
    ...(read.classification.mediaType === undefined
      ? {}
      : { mimeType: read.classification.mediaType }),
  }));
}

async function readTransientOutboundAttachment(input: {
  readonly uri: string;
  readonly transientAccess: ScopedTransientResourceAccess | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<ResultType<OutboundAttachmentSource, ServerToolFailure>> {
  if (!input.transientAccess) {
    return Result.err(
      attachmentFailure("not_found", "Transient resource is unavailable without a session scope"),
    );
  }

  const read = (
    await input.transientAccess.readContent(input.uri, {
      maxBytes: DEFAULT_OUTBOUND_MAX_FILE_BYTES,
      ...(input.signal ? { signal: input.signal } : {}),
    })
  ).mapError(attachmentFailureFromResource);
  return read.map((content) => ({
    bytes: Buffer.from(content.data),
    filename: content.filename,
    mimeType: content.mimeType,
  }));
}

async function readOutboundAttachment(input: {
  readonly source: string;
  readonly cwd: string;
  readonly context: RequestContext | undefined;
  readonly signal: AbortSignal | undefined;
  readonly resourceAccess: ResourceAccess | undefined;
  readonly transientAccess: ScopedTransientResourceAccess | undefined;
}): Promise<ResultType<OutboundAttachmentSource, ServerToolFailure>> {
  if (isCoreToolResultResourceUri(input.source)) {
    return readTransientOutboundAttachment({
      uri: input.source,
      transientAccess: input.transientAccess,
      signal: input.signal,
    });
  }
  if (input.source.startsWith("resource://")) {
    return readRetainedOutboundAttachment({
      uri: input.source,
      resourceAccess: input.resourceAccess,
      signal: input.signal,
    });
  }
  return readLocalOutboundAttachment({
    path: input.source,
    cwd: input.cwd,
    context: input.context,
    signal: input.signal,
  });
}

export type NativeAttachmentOutput = (
  context: RequestContext,
  input: {
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  },
) => Promise<ResultType<void, ServerToolFailure>>;

export class Attachment implements ServerTool {
  id = "attachment";
  private readonly tool: ServerTool;

  constructor(
    private readonly params: {
      bus: LilacBus;
      blobStore: BlobStore;
      outputLifecycle: AttachmentOutputLifecycle;
      nativeOutput?: NativeAttachmentOutput;
      resourceAccess?: ResourceAccess;
      resourceAccessForContext?: (
        context: RequestContext | undefined,
      ) => ResourceAccess | undefined;
      toolResultArtifacts?: ToolResultArtifactStore;
    },
  ) {
    this.tool = defineServerTool({
      id: this.id,
      callables: ({ callable }) => ({
        "attachment.add_files": callable({
          name: "Attachment Add Files",
          description: "Reads local files or resources and attaches them to the current reply.",
          inputSchema: attachmentAddFilesInputSchema,
          primaryPositional: {
            field: "paths",
            variadic: true,
          },
          cli: {
            shortInput: ["--paths=<string | string[]>"],
            input: [
              "--paths=<string | string[]> | Local file paths or resource:// URIs (preferred; alias: files)",
              "--filenames=<string | string[]> | Optional filenames (same length as paths)",
              "--mimeTypes=<string | string[]> | Optional mime types (same length as paths)",
            ],
          },
          run: (input, opts) => this.callAddFiles(input, opts?.context, opts?.signal),
        }),
      }),
    });
  }

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return await this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return await this.tool.call(callableId, input, opts);
  }

  private async callAddFiles(
    input: z.output<typeof attachmentAddFilesInputSchema>,
    ctx: RequestContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ServerToolResult> {
    const headersResult = toHeaders(ctx);
    const headersBranch = resultBranch(headersResult);
    if ("failure" in headersBranch) return Result.err(headersBranch.failure);
    const headers = headersBranch.value;

    const cwd = ctx?.cwd ?? process.cwd();
    const transientAccess =
      this.params.toolResultArtifacts && ctx?.sessionId
        ? bindTransientResourceAccess(this.params.toolResultArtifacts, ctx.sessionId)
        : undefined;

    let totalBytes = 0;

    const out: Array<{ filename: string; mimeType: string; bytes: number }> = [];

    for (let i = 0; i < input.paths.length; i++) {
      const sourceInput = input.paths[i]!;
      const loaded = await readOutboundAttachment({
        source: sourceInput,
        cwd,
        context: ctx,
        signal,
        resourceAccess: this.params.resourceAccessForContext
          ? this.params.resourceAccessForContext(ctx)
          : this.params.resourceAccess,
        transientAccess,
      });
      const loadedBranch = resultBranch(loaded);
      if ("failure" in loadedBranch) return Result.err(loadedBranch.failure);
      const source = loadedBranch.value;

      totalBytes += source.bytes.byteLength;
      if (totalBytes > DEFAULT_OUTBOUND_MAX_TOTAL_BYTES) {
        return Result.err(
          attachmentFailure(
            "usage",
            `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_OUTBOUND_MAX_TOTAL_BYTES} bytes.`,
          ),
        );
      }

      const bytes = source.bytes;
      const filename = (input.filenames && input.filenames[i]) || source.filename;

      const typeFromBytes = await fileTypeFromBuffer(bytes);

      const mimeType =
        (input.mimeTypes && input.mimeTypes[i]) ||
        typeFromBytes?.mime ||
        source.mimeType ||
        inferMimeTypeFromFilename(filename);

      if (ctx?.requestClient === "native" || ctx?.requestInitiator?.platform === "native") {
        if (!this.params.nativeOutput)
          return Result.err(
            attachmentFailure("unavailable", "Native attachment output is unavailable"),
          );
        const delivered = await this.params.nativeOutput(ctx, {
          filename,
          mediaType: mimeType,
          bytes,
        });
        const deliveredBranch = resultBranch(delivered);
        if ("failure" in deliveredBranch) return Result.err(deliveredBranch.failure);
        out.push({ filename, mimeType, bytes: bytes.byteLength });
        continue;
      }

      const uploadResult = (
        await this.params.blobStore.startUpload({
          source: bytes,
          retention: { kind: "durable" },
          expectedByteLength: bytes.byteLength,
        })
      ).mapError((error) =>
        attachmentFailure("unavailable", `Failed to reserve attachment output: ${error.message}`),
      );
      const uploadBranch = resultBranch(uploadResult);
      if ("failure" in uploadBranch) return Result.err(uploadBranch.failure);
      const upload = uploadBranch.value;

      const registered = (
        await this.params.outputLifecycle.registerOutputHandle({
          requestId: headers.request_id,
          requestDeliveryId: headers.request_delivery_id,
          handle: upload.handle,
          mimeType,
          filename,
        })
      ).mapError((error) => attachmentFailure("unavailable", error.message));
      const registeredBranch = resultBranch(registered);
      if ("failure" in registeredBranch) {
        const deleted = await this.params.blobStore.delete(upload.handle);
        deleted.match({ ok: () => undefined, err: () => undefined });
        return Result.err(registeredBranch.failure);
      }

      const published = (
        await this.params.bus.publish(
          lilacEventTypes.EvtAgentOutputResponseBinary,
          { blob: upload.handle, mimeType, filename },
          { headers },
        )
      ).mapError((error) => attachmentFailure("unavailable", error.message));
      const publishedBranch = resultBranch(published);
      if ("failure" in publishedBranch) return Result.err(publishedBranch.failure);

      out.push({ filename, mimeType, bytes: bytes.byteLength });
    }

    return Result.ok({ ok: true as const, attachments: out });
  }
}
