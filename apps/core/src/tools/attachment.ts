import { tool } from "ai";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import {
  createLogger,
  formatTaggedErrorForLog,
  opaqueErrorMessage,
  isRecord,
} from "@stanley2058/lilac-utils";
import { fileTypeFromBuffer } from "file-type";
import fs from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod/v4";
import { inferMimeTypeFromFilename, resolveToolPath } from "../shared/attachment-utils";
import { requireRequestContext } from "../shared/req-context";
import { adaptEventPublishResultToHost } from "../shared/event-bus-result";
import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";
import type { AttachmentOutputLifecycle } from "./attachment-output-lifecycle";

export {
  AttachmentOutputLifecycleError,
  type AttachmentOutputLifecycle,
} from "./attachment-output-lifecycle";

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

class AttachmentOperationError extends TaggedError("AttachmentOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

async function captureAttachmentOperation<T>(params: {
  readonly operation: string;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, AttachmentOperationError>> {
  const captured = (
    await Result.tryPromise({ try: params.run, catch: captureRuntimeError })
  ).mapError((error) =>
    projectCapturedRuntimeError(error, `Opaque attachment ${params.operation} failure`),
  );
  return captured.match<() => ResultType<T, AttachmentOperationError>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      const cause = preserveToolPanic(error);
      return Result.err(
        new AttachmentOperationError({
          operation: params.operation,
          cause,
          message: opaqueErrorMessage(cause, `Attachment ${params.operation} failed`),
        }),
      );
    },
  })();
}

function signalAttachmentFailure(operation: string, message: string): never {
  return adaptToolResultToHost(
    Result.err(new AttachmentOperationError({ operation, cause: new Error(message), message })),
  );
}

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
  if (!isRecord(raw)) return raw;

  const input = raw;
  if (input["paths"] !== undefined || input["files"] === undefined) {
    return raw;
  }

  return {
    ...input,
    paths: input["files"],
  };
}

const attachmentAddFilesInputSchema = z
  .preprocess(
    normalizeAttachmentAddFilesInput,
    z.object({
      paths: nonEmptyStringListInputSchema.describe(
        "Local file paths to attach (resolved relative to tool cwd; alias: files)",
      ),
      filenames: optionalNonEmptyStringListInputSchema.describe(
        "Optional filenames for each attachment",
      ),
      mimeTypes: optionalNonEmptyStringListInputSchema.describe(
        "Optional mime types for each attachment",
      ),
    }),
  )
  .describe("Add one or more attachments from local files.");

const attachmentAddOutputSchema = z.object({
  ok: z.literal(true),
  attachments: z.array(
    z.object({
      filename: z.string(),
      mimeType: z.string(),
      bytes: z.number(),
    }),
  ),
});
type AttachmentAddFilesOutput = z.infer<typeof attachmentAddOutputSchema>;

export function attachmentTools(params: {
  bus: LilacBus;
  blobStore: BlobStore;
  outputLifecycle: AttachmentOutputLifecycle;
  cwd: string;
}) {
  const { bus, blobStore, outputLifecycle, cwd } = params;
  const logger = createLogger({
    module: "tool:attachment",
  });

  return {
    "attachment.add_files": tool({
      description: "Reads local files and attaches them to the current reply.",
      inputSchema: attachmentAddFilesInputSchema,
      outputSchema: attachmentAddOutputSchema,
      execute: async (input, { context }) => {
        const ctx = requireRequestContext(context, "attachment.add_files");
        const startedAt = Date.now();

        logger.info("attachment.add_files", {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          requestClient: ctx.requestClient,
          cwd,
          pathCount: input.paths.length,
          filenameCount: input.filenames?.length,
          mimeTypeCount: input.mimeTypes?.length,
        });

        const runAddFiles = async () => {
          let totalBytes = 0;

          const out: Array<{
            filename: string;
            mimeType: string;
            bytes: number;
          }> = [];

          for (let i = 0; i < input.paths.length; i++) {
            const p = input.paths[i]!;
            const resolvedPath = resolveToolPath(cwd, p);

            const st = await fs.stat(resolvedPath);
            if (!st.isFile()) {
              signalAttachmentFailure("validate_outbound_file", `Not a file: ${resolvedPath}`);
            }

            if (st.size > DEFAULT_OUTBOUND_MAX_FILE_BYTES) {
              signalAttachmentFailure(
                "validate_outbound_file",
                `Attachment too large (${st.size} bytes). Max is ${DEFAULT_OUTBOUND_MAX_FILE_BYTES} bytes: ${resolvedPath}`,
              );
            }

            totalBytes += st.size;
            if (totalBytes > DEFAULT_OUTBOUND_MAX_TOTAL_BYTES) {
              signalAttachmentFailure(
                "validate_outbound_total",
                `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_OUTBOUND_MAX_TOTAL_BYTES} bytes.`,
              );
            }

            const bytes = await fs.readFile(resolvedPath);

            const filename = (input.filenames && input.filenames[i]) || basename(resolvedPath);

            const typeFromBytes = await fileTypeFromBuffer(bytes);

            const mimeType =
              (input.mimeTypes && input.mimeTypes[i]) ||
              typeFromBytes?.mime ||
              inferMimeTypeFromFilename(filename);

            const upload = (
              await blobStore.startUpload({
                source: bytes,
                retention: { kind: "durable" },
                expectedByteLength: bytes.byteLength,
              })
            ).match({
              ok: (value) => value,
              err: (error) =>
                signalAttachmentFailure(
                  "start_output_upload",
                  opaqueErrorMessage(error, "Failed to reserve attachment output"),
                ),
            });

            const registered = await outputLifecycle.registerOutputHandle({
              requestId: ctx.requestId,
              requestDeliveryId: ctx.requestDeliveryId,
              handle: upload.handle,
              mimeType,
              filename,
            });
            await registered.match<() => Promise<void>>({
              ok: () => async () => undefined,
              err: (error) => async () => {
                const deleted = await blobStore.delete(upload.handle);
                deleted.match({ ok: () => undefined, err: () => undefined });
                return adaptToolResultToHost(
                  Result.err(
                    new AttachmentOperationError({
                      operation: "register_output_upload",
                      cause: error,
                      message: error.message,
                    }),
                  ),
                );
              },
            })();

            adaptEventPublishResultToHost(
              await bus.publish(
                lilacEventTypes.EvtAgentOutputResponseBinary,
                { blob: upload.handle, mimeType, filename },
                {
                  headers: {
                    request_id: ctx.requestId,
                    session_id: ctx.sessionId,
                    request_client: ctx.requestClient,
                  },
                },
              ),
            );

            out.push({ filename, mimeType, bytes: bytes.byteLength });
          }

          const result = { ok: true as const, attachments: out };

          logger.info("attachment.add_files done", {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            requestClient: ctx.requestClient,
            durationMs: Date.now() - startedAt,
            attachmentCount: out.length,
            totalBytes: out.reduce((sum, att) => sum + att.bytes, 0),
          });

          return result;
        };
        const added = await captureAttachmentOperation({
          operation: "add_files",
          run: runAddFiles,
        });
        return added.match<() => AttachmentAddFilesOutput>({
          ok: (value) => () => value,
          err: (error) => () => {
            logger.error("attachment.add_files failed", {
              requestId: ctx.requestId,
              sessionId: ctx.sessionId,
              requestClient: ctx.requestClient,
              durationMs: Date.now() - startedAt,
              pathCount: input.paths.length,
              ...formatTaggedErrorForLog(error),
            });
            return adaptToolResultToHost(added);
          },
        })();
      },
    }),
  };
}
