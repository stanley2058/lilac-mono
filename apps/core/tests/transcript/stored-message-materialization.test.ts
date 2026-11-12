import { describe, expect, it } from "bun:test";

import type { ModelMessage } from "ai";
import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";
import type { StoredFilePartV1, StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

import {
  RESOURCE_MODEL_INLINE_MAX_BYTES,
  ResourceOriginUnavailable,
  ResourceTooLarge,
  type ResourceAccess,
  type ResourceClassification,
} from "../../src/resource";
import {
  createStoredMessageIdentityProjectionV1,
  materializeStoredMessagesV1,
  projectStoredMessagesV1,
  StoredMessageProjectionError,
} from "../../src/transcript/stored-message-materialization";

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function resourceAccess(input: {
  readonly mediaType?: string;
  readonly filename?: string;
  readonly classification: ResourceClassification;
  readonly bytes: Uint8Array;
  readonly openError?: ResourceOriginUnavailable | ResourceTooLarge;
  readonly onOpen?: (maxBytes: number) => void;
  readonly reportedByteLength?: number;
  readonly cachedByteLength?: number;
  readonly onCancel?: () => void;
}): Pick<ResourceAccess, "describe" | "open"> {
  const uri = "resource://r1_00000000000000000000000000000001" as const;
  return {
    describe: () =>
      Result.ok({
        uri,
        filename: input.filename ?? "attachment.bin",
        ...(input.mediaType === undefined ? {} : { declaredMediaType: input.mediaType }),
        reportedByteLength: input.reportedByteLength,
        cachedByteLength: input.cachedByteLength,
      }),
    open: async (_uri, options) => {
      input.onOpen?.(options.maxBytes);
      if (input.openError) return Result.err(input.openError);
      return Result.ok({
        descriptor: {
          uri,
          ...(input.mediaType === undefined ? {} : { declaredMediaType: input.mediaType }),
        },
        classification: input.classification,
        blob: {
          version: 1,
          objectId: "b1_00000000000000000000000000000000",
          sha256: "0".repeat(64),
          byteLength: input.bytes.byteLength,
        },
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(input.bytes);
            controller.close();
          },
          cancel: input.onCancel,
        }),
        completion: Promise.resolve(
          Result.ok({
            sha256: "0".repeat(64),
            byteLength: input.bytes.byteLength,
          }),
        ),
      });
    },
  };
}

const storedImageResource = [
  {
    role: "user",
    content: [
      {
        type: "resource",
        uri: "resource://r1_00000000000000000000000000000001",
        filename: "image.png",
        mediaType: "image/png",
      },
    ],
  },
] satisfies StoredMessageV1[];

describe("stored message materialization", () => {
  it("strictly rejects inline bytes and unresolved handles", () => {
    const inline = projectStoredMessagesV1([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "application/octet-stream",
          },
        ],
      },
    ]);
    expect(inline.status).toBe("error");
    if (inline.status === "error")
      expect(inline.error).toBeInstanceOf(StoredMessageProjectionError);

    const handle = projectStoredMessagesV1([
      {
        role: "user",
        content: [
          {
            type: "blob",
            blob: {
              version: 1,
              objectId: "b1_00000000000000000000000000000000",
            },
            mediaType: "application/octet-stream",
          },
        ],
      },
    ]);
    expect(handle.status).toBe("error");
  });

  it("verifies blobs before returning provider messages", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new TextEncoder().encode("verified attachment");
    const upload = resultValue(
      await blobStore.startUpload({
        source: bytes,
        retention: { kind: "durable" },
      }),
    );
    const blob = resultValue(await upload.completion);
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "blob",
            blob,
            mediaType: "text/plain",
            filename: "attachment.txt",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(await materializeStoredMessagesV1({ messages, blobStore }));
    expect(materialized).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "file",
            data: bytes,
            mediaType: "text/plain",
            filename: "attachment.txt",
          },
        ],
      },
    ]);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("keeps structured resource identity beside marker-only provider messages", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "unsafe\nname.png",
            mediaType: "image/png",
            size: 321,
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    const identityProjection = createStoredMessageIdentityProjectionV1();

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        identityProjection,
      }),
    );

    expect(materialized).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "text",
            text: '[attachment uri="resource://r1_00000000000000000000000000000001" filename="unsafe_name.png" mime="image/png" size=321]',
          },
        ],
      },
    ]);
    expect(resultValue(identityProjection.project(materialized))).toEqual(messages);
    expect(resultValue(projectStoredMessagesV1(materialized))).not.toEqual(messages);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("projects a resource read, grep, and materialize flow without persisting inline bytes", () => {
    const imageUri = "resource://r1_00000000000000000000000000000001";
    const textUri = "resource://r1_00000000000000000000000000000002";
    const inlineImage = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-image",
            toolName: "read",
            input: { path: imageUri },
          },
          {
            type: "tool-call",
            toolCallId: "read-text",
            toolName: "read",
            input: { path: textUri },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-image",
            toolName: "read",
            output: {
              type: "content",
              value: [
                {
                  type: "text",
                  text: "Attached file from read: image.png (image/png, 4 bytes).",
                },
                {
                  type: "file",
                  data: { type: "data", data: inlineImage },
                  mediaType: "image/png",
                  filename: "image.png",
                },
              ],
            },
          },
          {
            type: "tool-result",
            toolCallId: "read-text",
            toolName: "read",
            output: {
              type: "json",
              value: {
                success: true,
                kind: "text",
                resolvedPath: textUri,
                content: "LILAC_RESOURCE_TEST_4821",
              },
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "grep-text",
            toolName: "grep",
            input: { path: textUri, pattern: "LILAC_RESOURCE_TEST_4821" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "grep-text",
            toolName: "grep",
            output: {
              type: "json",
              value: { mode: "default", matches: [{ path: textUri, line: 1 }] },
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "materialize",
            toolName: "bash",
            input: {
              command: `tools resource.materialize '${imageUri}' '${textUri}'`,
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "materialize",
            toolName: "bash",
            output: {
              type: "text",
              value: "Materialized image.png and notes.txt",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "Both resources passed read, grep, and materialize.",
      },
    ] satisfies ModelMessage[];

    expect(projectStoredMessagesV1(messages).status).toBe("error");

    const projected = resultValue(createStoredMessageIdentityProjectionV1().project(messages));
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(inlineImage);
    expect(projected[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "read-image",
          toolName: "read",
          output: {
            type: "content",
            value: [
              {
                type: "text",
                text: "Attached file from read: image.png (image/png, 4 bytes).",
              },
              {
                type: "resource",
                uri: imageUri,
                filename: "image.png",
                mediaType: "image/png",
              },
            ],
          },
        },
        {
          type: "tool-result",
          toolCallId: "read-text",
          toolName: "read",
          output: {
            type: "json",
            value: {
              success: true,
              kind: "text",
              resolvedPath: textUri,
              content: "LILAC_RESOURCE_TEST_4821",
            },
          },
        },
      ],
    });
    expect(projected).toHaveLength(messages.length);
  });

  it("stores a local read file as a durable blob and restores the provider file on replay", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const base64 = bytes.toString("base64");
    const providerMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-local-image",
            toolName: "read",
            input: { path: "/tmp/crop.png" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-local-image",
            toolName: "read",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Attached file from read: crop.png" },
                {
                  type: "file",
                  data: { type: "data", data: base64 },
                  mediaType: "image/png",
                  filename: "crop.png",
                },
              ],
            },
          },
        ],
      },
    ] satisfies ModelMessage[];
    const clonedMessages = structuredClone(providerMessages) as ModelMessage[];
    const projected = resultValue(
      await createStoredMessageIdentityProjectionV1().projectForPersistence({
        providerMessages: clonedMessages,
        blobStore,
        retainUploadedFile: () => Result.ok(undefined),
      }),
    );

    expect(projected.uploadedFiles).toHaveLength(1);
    expect(projected.messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "read-local-image",
          toolName: "read",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Attached file from read: crop.png" },
              {
                type: "blob",
                blob: projected.uploadedFiles[0]!.blob,
                mediaType: "image/png",
                filename: "crop.png",
              },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(projected.messages)).not.toContain(base64);

    const replayed = resultValue(
      await materializeStoredMessagesV1({ messages: projected.messages, blobStore }),
    );
    expect(replayed[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "read-local-image",
          toolName: "read",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Attached file from read: crop.png" },
              {
                type: "file",
                data: { type: "data", data: base64 },
                mediaType: "image/png",
                filename: "crop.png",
              },
            ],
          },
        },
      ],
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("keeps cloned resource reads as resource references during durable projection", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const uri = "resource://r1_00000000000000000000000000000001" as const;
    const inlineImage = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const providerMessages = structuredClone([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-resource-image",
            toolName: "read",
            input: { path: uri },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-resource-image",
            toolName: "read",
            output: {
              type: "content",
              value: [
                {
                  type: "file",
                  data: { type: "data", data: inlineImage },
                  mediaType: "image/png",
                  filename: "image.png",
                },
              ],
            },
          },
        ],
      },
    ] satisfies ModelMessage[]) as ModelMessage[];
    const retainedFiles: unknown[] = [];

    const projected = resultValue(
      await createStoredMessageIdentityProjectionV1().projectForPersistence({
        providerMessages,
        blobStore,
        retainUploadedFile: (file) => {
          retainedFiles.push(file);
          return Result.ok(undefined);
        },
      }),
    );

    expect(retainedFiles).toEqual([]);
    expect(projected.uploadedFiles).toEqual([]);
    expect(projected.messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "read-resource-image",
          toolName: "read",
          output: {
            type: "content",
            value: [
              {
                type: "resource",
                uri,
                mediaType: "image/png",
                filename: "image.png",
              },
            ],
          },
        },
      ],
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("deletes a provider upload when durable ownership cannot be recorded", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const providerMessages = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: Buffer.from("unretained provider file").toString("base64"),
            mediaType: "text/plain",
            filename: "unretained.txt",
          },
        ],
      },
    ] satisfies ModelMessage[];
    const uploadedFiles: StoredFilePartV1[] = [];

    const projected = await createStoredMessageIdentityProjectionV1().projectForPersistence({
      providerMessages,
      blobStore,
      retainUploadedFile: (file) => {
        uploadedFiles.push(file);
        return Result.err(new StoredMessageProjectionError({ message: "retention rejected" }));
      },
    });

    expect(projected.status).toBe("error");
    const uploadedFile = uploadedFiles[0];
    if (!uploadedFile) throw new Error("expected provider upload");
    expect((await blobStore.open(uploadedFile.blob)).status).toBe("error");

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("does not retain an uploaded provider file after persistence is abandoned", async () => {
    const baseBlobStore = resultValue(await createMemoryBlobStore());
    const uploadStarted = Promise.withResolvers<void>();
    const releaseUpload = Promise.withResolvers<void>();
    let abandoned = false;
    let retainCalls = 0;
    const blobStore: Pick<BlobStore, "startUpload" | "delete"> = {
      startUpload: async (input) => {
        const started = await baseBlobStore.startUpload(input);
        return started.map((upload) => ({
          ...upload,
          completion: (async () => {
            uploadStarted.resolve();
            await releaseUpload.promise;
            return await upload.completion;
          })(),
        }));
      },
      delete: (target) => baseBlobStore.delete(target),
    };
    const projection = createStoredMessageIdentityProjectionV1().projectForPersistence({
      providerMessages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: Buffer.from("abandoned provider file").toString("base64"),
              mediaType: "text/plain",
              filename: "abandoned.txt",
            },
          ],
        },
      ],
      blobStore,
      shouldAbandon: () => abandoned,
      retainUploadedFile: () => {
        retainCalls += 1;
        return Result.ok(undefined);
      },
    });

    await uploadStarted.promise;
    abandoned = true;
    releaseUpload.resolve();

    expect((await projection).status).toBe("error");
    expect(retainCalls).toBe(0);
    resultValue(await baseBlobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("deletes an upload handle when persistence is abandoned as the upload starts", async () => {
    const baseBlobStore = resultValue(await createMemoryBlobStore());
    const uploadStarted = Promise.withResolvers<void>();
    const releaseUploadStart = Promise.withResolvers<void>();
    let abandoned = false;
    let startedHandle: Parameters<BlobStore["delete"]>[0] | undefined;
    let deletedTarget: Parameters<BlobStore["delete"]>[0] | undefined;
    const blobStore: Pick<BlobStore, "startUpload" | "delete"> = {
      startUpload: async (input) => {
        const started = await baseBlobStore.startUpload(input);
        started.match({
          ok: (upload) => {
            startedHandle = upload.handle;
          },
          err: () => undefined,
        });
        uploadStarted.resolve();
        await releaseUploadStart.promise;
        return started;
      },
      delete: (target) => {
        deletedTarget = target;
        return baseBlobStore.delete(target);
      },
    };
    const projection = createStoredMessageIdentityProjectionV1().projectForPersistence({
      providerMessages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: Buffer.from("abandoned provider upload").toString("base64"),
              mediaType: "text/plain",
              filename: "abandoned-start.txt",
            },
          ],
        },
      ],
      blobStore,
      shouldAbandon: () => abandoned,
      retainUploadedFile: () => Result.ok(undefined),
    });

    await uploadStarted.promise;
    abandoned = true;
    releaseUploadStart.resolve();

    expect((await projection).status).toBe("error");
    expect(startedHandle).toBeDefined();
    expect(deletedTarget).toEqual(startedHandle);
    resultValue(await baseBlobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("correlates reused read call IDs with their results in transcript order", () => {
    const firstUri = "resource://r1_00000000000000000000000000000001";
    const secondUri = "resource://r1_00000000000000000000000000000002";
    const inlineImage = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const readCall = (uri: string) =>
      ({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "reused-read-id",
            toolName: "read",
            input: { path: uri },
          },
        ],
      }) satisfies ModelMessage;
    const readResult = (filename: string) =>
      ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "reused-read-id",
            toolName: "read",
            output: {
              type: "content",
              value: [
                {
                  type: "file",
                  data: { type: "data", data: inlineImage },
                  mediaType: "image/png",
                  filename,
                },
              ],
            },
          },
        ],
      }) satisfies ModelMessage;
    const messages = [
      readCall(firstUri),
      readResult("first.png"),
      readCall(secondUri),
      readResult("second.png"),
    ];

    const identityProjection = createStoredMessageIdentityProjectionV1();
    const rememberedMessages = messages.slice(0, 2);
    const rememberedStored = resultValue(identityProjection.project(rememberedMessages));
    resultValue(identityProjection.remember(rememberedMessages, rememberedStored));

    const projected = resultValue(identityProjection.project(messages));
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(inlineImage);
    expect(serialized).toContain(firstUri);
    expect(serialized).toContain(secondUri);
    expect(projected[1]).toMatchObject({
      content: [{ output: { value: [{ type: "resource", uri: firstUri }] } }],
    });
    expect(projected[3]).toMatchObject({
      content: [{ output: { value: [{ type: "resource", uri: secondUri }] } }],
    });
  });

  it("adds verified byte-backed images for a capable AI SDK provider", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const identityProjection = createStoredMessageIdentityProjectionV1();
    let openedWith = 0;

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages: storedImageResource,
        blobStore,
        identityProjection,
        resourceAccess: resourceAccess({
          bytes,
          mediaType: "image/png",
          classification: { kind: "image", mediaType: "image/png" },
          onOpen: (maxBytes) => {
            openedWith = maxBytes;
          },
        }),
        resourceTarget: {
          family: "ai-sdk",
          supportsImage: true,
          supportsPdf: true,
        },
      }),
    );

    expect(openedWith).toBe(RESOURCE_MODEL_INLINE_MAX_BYTES);
    expect(materialized[0]?.content).toEqual([
      {
        type: "text",
        text: '[attachment uri="resource://r1_00000000000000000000000000000001" filename="image.png" mime="image/png"]',
      },
      {
        type: "file",
        data: bytes,
        mediaType: "image/png",
        filename: "image.png",
      },
    ]);
    const agentClone = materialized.map((message): ModelMessage => {
      if (message.role === "assistant") {
        return {
          ...message,
          content: Array.isArray(message.content)
            ? message.content.map((part) => ({ ...part }))
            : message.content,
        };
      }
      if (message.role === "tool") {
        return { ...message, content: message.content.map((part) => ({ ...part })) };
      }
      if (message.role === "user" && Array.isArray(message.content)) {
        return { ...message, content: message.content.map((part) => ({ ...part })) };
      }
      return { ...message };
    });
    expect(resultValue(identityProjection.project(agentClone))).toEqual(storedImageResource);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("wraps resource bytes embedded in tool results for the provider contract", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const identityProjection = createStoredMessageIdentityProjectionV1();
    const uri = "resource://r1_00000000000000000000000000000001" as const;
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-resource-image",
            toolName: "read",
            input: { path: uri },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-resource-image",
            toolName: "read",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Attached file from read: image.png" },
                { type: "resource", uri, filename: "image.png", mediaType: "image/png" },
              ],
            },
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        identityProjection,
        resourceAccess: resourceAccess({
          bytes,
          mediaType: "image/png",
          classification: { kind: "image", mediaType: "image/png" },
        }),
        resourceTarget: {
          family: "ai-sdk",
          supportsImage: true,
          supportsPdf: true,
        },
      }),
    );

    expect(materialized[1]).toMatchObject({
      role: "tool",
      content: [
        {
          output: {
            type: "content",
            value: [
              { type: "text", text: "Attached file from read: image.png" },
              { type: "text" },
              {
                type: "file",
                data: { type: "data", data: Buffer.from(bytes).toString("base64") },
                mediaType: "image/png",
                filename: "image.png",
              },
            ],
          },
        },
      ],
    });
    const agentClone = materialized.map((message): ModelMessage => {
      if (message.role === "tool") {
        return { ...message, content: message.content.map((part) => ({ ...part })) };
      }
      if (message.role === "assistant" && Array.isArray(message.content)) {
        return { ...message, content: message.content.map((part) => ({ ...part })) };
      }
      return { ...message };
    });
    expect(resultValue(identityProjection.project(agentClone))).toEqual(messages);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("keeps Claude PDFs marker-only with materialization guidance", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "document.pdf",
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: resourceAccess({
          bytes: new TextEncoder().encode("%PDF-1.7"),
          mediaType: "application/pdf",
          classification: { kind: "pdf", mediaType: "application/pdf" },
        }),
        resourceTarget: {
          family: "claude-code",
          supportsImage: true,
          supportsPdf: false,
        },
      }),
    );

    expect(materialized[0]?.content).toEqual([
      {
        type: "text",
        text: '[attachment uri="resource://r1_00000000000000000000000000000001" filename="document.pdf" mime="application/pdf"]',
      },
      {
        type: "text",
        text: '[resource_inline_error uri="resource://r1_00000000000000000000000000000001" code="unsupported_provider"]',
      },
      {
        type: "text",
        text: "Use resource.materialize to write this resource into the working directory, transform it to a supported size or format, and then consume the transformed file.",
      },
    ]);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("supports AI SDK PDFs and Claude images", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const pdfBytes = new TextEncoder().encode("%PDF-1.7");
    const pdfMessages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    const aiSdkPdf = resultValue(
      await materializeStoredMessagesV1({
        messages: pdfMessages,
        blobStore,
        resourceAccess: resourceAccess({
          bytes: pdfBytes,
          mediaType: "application/pdf",
          classification: { kind: "pdf", mediaType: "application/pdf" },
        }),
        resourceTarget: {
          family: "ai-sdk",
          supportsImage: true,
          supportsPdf: true,
        },
      }),
    );
    const claudeImage = resultValue(
      await materializeStoredMessagesV1({
        messages: storedImageResource,
        blobStore,
        resourceAccess: resourceAccess({
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mediaType: "image/png",
          classification: { kind: "image", mediaType: "image/png" },
        }),
        resourceTarget: {
          family: "claude-code",
          supportsImage: true,
          supportsPdf: false,
        },
      }),
    );

    expect(aiSdkPdf[0]?.content).toContainEqual({
      type: "file",
      data: pdfBytes,
      mediaType: "application/pdf",
    });
    expect(claudeImage[0]?.content).toContainEqual({
      type: "file",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mediaType: "image/png",
      filename: "image.png",
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("turns expected resource open failures into marker guidance", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const openError = new ResourceTooLarge({
      uri: "resource://r1_00000000000000000000000000000001",
      limit: RESOURCE_MODEL_INLINE_MAX_BYTES,
      limitKind: "operation",
      reportedBytes: RESOURCE_MODEL_INLINE_MAX_BYTES + 1,
      message: "Resource exceeds the inline limit",
    });

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages: storedImageResource,
        blobStore,
        resourceAccess: resourceAccess({
          bytes: new Uint8Array(),
          mediaType: "image/png",
          classification: { kind: "image", mediaType: "image/png" },
          openError,
        }),
        resourceTarget: {
          family: "ai-sdk",
          supportsImage: true,
          supportsPdf: true,
        },
      }),
    );

    expect(materialized[0]?.content).toContainEqual({
      type: "text",
      text: `[resource_inline_error uri="resource://r1_00000000000000000000000000000001" code="too_large" limit=${1024 * 1024}]`,
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  for (const sizeSource of ["reportedByteLength", "cachedByteLength", "size"] as const) {
    it(`checks actual bytes when image metadata overstates size (${sizeSource})`, async () => {
      const blobStore = resultValue(await createMemoryBlobStore());
      const original = [
        {
          role: "user",
          content: [
            {
              ...storedImageResource[0]!.content[0]!,
              ...(sizeSource === "size" ? { size: 1024 * 1024 + 1 } : {}),
            },
          ],
        },
      ] satisfies StoredMessageV1[];
      const identityProjection = createStoredMessageIdentityProjectionV1();
      let opened = false;
      const materialized = resultValue(
        await materializeStoredMessagesV1({
          messages: original,
          blobStore,
          identityProjection,
          resourceAccess: resourceAccess({
            bytes: new Uint8Array(),
            mediaType: "image/png",
            classification: { kind: "image", mediaType: "image/png" },
            ...(sizeSource === "size" ? {} : { [sizeSource]: 1024 * 1024 + 1 }),
            onOpen: () => {
              opened = true;
            },
          }),
          resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
        }),
      );
      expect(opened).toBe(true);
      expect(materialized[0]?.content).toContainEqual({
        type: "file",
        data: new Uint8Array(),
        mediaType: "image/png",
        filename: "image.png",
      });
      expect(resultValue(identityProjection.project(materialized))).toEqual(original);
      const pastedMarker = [
        { role: "user", content: [{ type: "text", text: original[0]!.content[0]!.uri }] },
      ] satisfies ModelMessage[];
      expect(resultValue(identityProjection.project(pastedMarker))).toEqual(pastedMarker);
      resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
    });
  }

  it("checks verified image size when metadata is missing or understated", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    for (const mediaType of [undefined, "image/png"]) {
      const messages = [
        {
          role: "user",
          content: [{ type: "resource", uri: storedImageResource[0]!.content[0]!.uri }],
        },
      ] satisfies StoredMessageV1[];
      let cancelled = false;
      const materialized = resultValue(
        await materializeStoredMessagesV1({
          messages,
          blobStore,
          resourceAccess: resourceAccess({
            bytes: new Uint8Array(1024 * 1024 + 1),
            mediaType,
            reportedByteLength: 4,
            classification: { kind: "image", mediaType: "image/png" },
            onCancel: () => {
              cancelled = true;
            },
          }),
          resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
        }),
      );
      expect(cancelled).toBe(true);
      expect(materialized[0]?.content).toContainEqual({
        type: "text",
        text: expect.stringContaining("Image exceeds"),
      });
      expect(JSON.stringify(materialized)).not.toContain('"type":"file"');
    }
    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("retains the existing PDF inline limit", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new Uint8Array(1024 * 1024 + 1);
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: storedImageResource[0]!.content[0]!.uri,
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    let openedWith = 0;
    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: resourceAccess({
          bytes,
          mediaType: "application/pdf",
          reportedByteLength: bytes.byteLength,
          classification: { kind: "pdf", mediaType: "application/pdf" },
          onOpen: (maxBytes) => {
            openedWith = maxBytes;
          },
        }),
        resourceTarget: { family: "ai-sdk", supportsImage: true, supportsPdf: true },
      }),
    );
    expect(openedWith).toBe(RESOURCE_MODEL_INLINE_MAX_BYTES);
    expect(materialized[0]?.content).toContainEqual({
      type: "file",
      data: bytes,
      mediaType: "application/pdf",
    });
    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("uses filenames only to skip known text before signature verification", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "photo.PNG",
            mediaType: "application/octet-stream",
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    let expected: string | undefined;
    const access = resourceAccess({
      filename: "photo.PNG",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      classification: { kind: "image", mediaType: "image/png" },
    });
    const observedAccess = {
      ...access,
      open: async (...args: Parameters<typeof access.open>) => {
        expected = args[1].expected;
        return await access.open(...args);
      },
    };

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: observedAccess,
        resourceTarget: {
          family: "ai-sdk",
          supportsImage: true,
          supportsPdf: true,
        },
      }),
    );

    expect(expected).toBe("any");
    expect(materialized[0]?.content).toContainEqual({
      type: "file",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mediaType: "image/png",
      filename: "photo.PNG",
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("treats stored and declared media types as informational when bytes classify differently", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const access = resourceAccess({
      filename: "upload",
      mediaType: "application/pdf",
      bytes,
      classification: { kind: "image", mediaType: "image/png" },
    });
    let expected: string | undefined;
    const observedAccess = {
      ...access,
      open: async (...args: Parameters<typeof access.open>) => {
        expected = args[1].expected;
        return await access.open(...args);
      },
    };
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "upload",
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: observedAccess,
        resourceTarget: {
          family: "claude-code",
          supportsImage: true,
          supportsPdf: false,
        },
      }),
    );

    expect(expected).toBe("any");
    expect(materialized[0]?.content).toContainEqual({
      type: "file",
      data: bytes,
      mediaType: "image/png",
      filename: "upload",
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("sniffs absent media metadata without relying on a filename extension", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    let expected: string | undefined;
    const access = resourceAccess({
      filename: "upload",
      bytes,
      classification: { kind: "image", mediaType: "image/png" },
    });
    const observedAccess = {
      ...access,
      open: async (...args: Parameters<typeof access.open>) => {
        expected = args[1].expected;
        return await access.open(...args);
      },
    };
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri: "resource://r1_00000000000000000000000000000001",
            filename: "upload",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: observedAccess,
        resourceTarget: {
          family: "ai-sdk",
          supportsImage: true,
          supportsPdf: true,
        },
      }),
    );

    expect(expected).toBe("any");
    expect(materialized[0]?.content).toContainEqual({
      type: "file",
      data: bytes,
      mediaType: "image/png",
      filename: "upload",
    });

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("cancels sniffed text instead of consuming it into provider bytes", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    const uri = "resource://r1_00000000000000000000000000000001" as const;
    let cancelled = false;
    const access: Pick<ResourceAccess, "describe" | "open"> = {
      describe: () => Result.ok({ uri, filename: "upload" }),
      open: async (_uri, options) => {
        expect(options.expected).toBe("any");
        return Result.ok({
          descriptor: { uri, filename: "upload" },
          classification: {
            kind: "text",
            mediaType: "text/plain",
            encoding: "utf-8",
          },
          blob: {
            version: 1,
            objectId: "b1_00000000000000000000000000000000",
            sha256: "0".repeat(64),
            byteLength: 10,
          },
          stream: new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          completion: Promise.resolve(Result.ok({ sha256: "0".repeat(64), byteLength: 10 })),
        });
      },
    };
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            uri,
            filename: "upload",
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const materialized = resultValue(
      await materializeStoredMessagesV1({
        messages,
        blobStore,
        resourceAccess: access,
        resourceTarget: {
          family: "ai-sdk",
          supportsImage: true,
          supportsPdf: true,
        },
      }),
    );

    expect(cancelled).toBe(true);
    expect(materialized[0]?.content).toEqual([
      {
        type: "text",
        text: '[attachment uri="resource://r1_00000000000000000000000000000001" filename="upload"]',
      },
    ]);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("keeps every previously missed text filename marker-only without provider fetching", async () => {
    const blobStore = resultValue(await createMemoryBlobStore());
    let openCount = 0;
    for (const extension of [".cjs", ".cts", ".hpp", ".htm", ".jsonc", ".mdx", ".mts", ".svg"]) {
      const filename = `notes${extension}`;
      const access = resourceAccess({
        filename,
        bytes: new TextEncoder().encode("plain text"),
        classification: {
          kind: "text",
          mediaType: "text/plain",
          encoding: "utf-8",
        },
        onOpen: () => {
          openCount += 1;
        },
      });
      const messages = [
        {
          role: "user",
          content: [
            {
              type: "resource",
              uri: "resource://r1_00000000000000000000000000000001",
              filename,
            },
          ],
        },
      ] satisfies StoredMessageV1[];

      const materialized = resultValue(
        await materializeStoredMessagesV1({
          messages,
          blobStore,
          resourceAccess: access,
          resourceTarget: {
            family: "ai-sdk",
            supportsImage: true,
            supportsPdf: true,
          },
        }),
      );
      expect(materialized[0]?.content).toEqual([
        {
          type: "text",
          text: `[attachment uri="resource://r1_00000000000000000000000000000001" filename="${filename}"]`,
        },
      ]);
    }

    expect(openCount).toBe(0);

    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });
});
