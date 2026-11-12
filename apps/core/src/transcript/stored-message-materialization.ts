import { modelMessageSchema, type ModelMessage } from "ai";
import {
  materializeBlobRead,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import {
  storedFilePartV1Schema,
  storedResourcePartV1Schema,
  type StoredFilePartV1,
  type StoredMessageV1,
  type StoredResourcePartV1,
} from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  cancelVerifiedResourceRead,
  consumeVerifiedResourceRead,
  hasResourceTextFilenameHint,
  RESOURCE_MODEL_INLINE_MAX_BYTES,
  RESOURCE_IMAGE_INLINE_MAX_BYTES,
  type ResourceAccess,
  type ResourceAccessError,
} from "../resource";
import {
  defaultStoredBlobFilename,
  normalizeStoredMessagesV1,
} from "./transcript-persistence-codec";

export class StoredMessageProjectionError extends TaggedError("StoredMessageProjectionError")<{
  readonly message: string;
}> {}

export class StoredMessageMaterializationError extends TaggedError(
  "StoredMessageMaterializationError",
)<{
  readonly stage: "open" | "read" | "decode";
  readonly message: string;
}> {}

export type StoredMessageMaterializationFailure =
  | StoredMessageProjectionError
  | StoredMessageMaterializationError;

export type StoredResourceProviderTarget = {
  readonly family: "ai-sdk" | "claude-code";
  readonly supportsImage: boolean;
  readonly supportsPdf: boolean;
};

export type StoredMessageIdentityProjectionV1 = {
  remember(
    providerMessages: readonly ModelMessage[],
    storedMessages: readonly StoredMessageV1[],
  ): ResultType<void, StoredMessageProjectionError>;
  project(
    providerMessages: readonly (ModelMessage | StoredMessageV1)[],
  ): ResultType<StoredMessageV1[], StoredMessageProjectionError>;
  projectForPersistence(input: {
    readonly providerMessages: readonly (ModelMessage | StoredMessageV1)[];
    readonly blobStore: Pick<BlobStore, "startUpload" | "delete">;
    readonly shouldAbandon?: () => boolean;
    readonly retainUploadedFile: (
      file: StoredFilePartV1,
    ) => ResultType<void, StoredMessageProjectionError>;
  }): Promise<ResultType<StoredMessagePersistenceProjectionV1, StoredMessageProjectionError>>;
};

export type StoredMessagePersistenceProjectionV1 = {
  readonly messages: StoredMessageV1[];
  readonly uploadedFiles: readonly StoredFilePartV1[];
};

type ModelAssistantMessage = Extract<ModelMessage, { readonly role: "assistant" }>;
type ModelUserMessage = Extract<ModelMessage, { readonly role: "user" }>;
type ModelToolMessage = Extract<ModelMessage, { readonly role: "tool" }>;
type ModelUserPart = Exclude<ModelUserMessage["content"], string>[number];
type ModelAssistantPart = Exclude<ModelAssistantMessage["content"], string>[number];
type ModelToolPart = ModelToolMessage["content"][number];
type ModelToolResultPart = Extract<
  ModelAssistantPart | ModelToolPart,
  { readonly type: "tool-result" }
>;
type ModelToolResultContentPart = Extract<
  ModelToolResultPart["output"],
  { readonly type: "content" }
>["value"][number];
type ModelPart = ModelUserPart | ModelAssistantPart | ModelToolPart;
type ModelFilePart = Extract<
  ModelUserPart | ModelAssistantPart | ModelToolResultContentPart,
  {
    readonly type: "file";
  }
>;

type RememberedProviderMessage =
  | { readonly kind: "remembered"; readonly message: StoredMessageV1 }
  | { readonly kind: "ambiguous" };
type ProviderFileIdentityPart = {
  readonly type: string;
  readonly data?: ModelFilePart["data"];
};

const resourceReadInputSchema = z.object({ path: storedResourcePartV1Schema.shape.uri });
type PendingResourcesByToolCallId = Map<string, Array<StoredResourcePartV1 | undefined>>;
type ResourceReadCallDecision =
  | { readonly kind: "not-read" }
  | {
      readonly kind: "read";
      readonly toolCallId: string;
      readonly resource: StoredResourcePartV1 | undefined;
    };

function decodeProviderMessageForPersistence(
  value: unknown,
): ResultType<ModelMessage, StoredMessageProjectionError> {
  const decoded = modelMessageSchema.safeParse(value);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(
        new StoredMessageProjectionError({
          message: "Provider message cannot be decoded for durable file projection",
        }),
      );
}

function resourceFromReadFilePart(
  value: ModelToolResultContentPart,
  resource: StoredResourcePartV1,
): ModelToolResultContentPart | StoredResourcePartV1 {
  if (value.type !== "file") return value;
  return {
    ...resource,
    ...(value.filename === undefined ? {} : { filename: value.filename }),
    mediaType: value.mediaType,
  };
}

function decodeResourceReadCallForStorage(part: ModelPart): ResourceReadCallDecision {
  if (part.type !== "tool-call" || part.toolName !== "read") return { kind: "not-read" };
  const input = resourceReadInputSchema.safeParse(part.input);
  return {
    kind: "read",
    toolCallId: part.toolCallId,
    resource: input.success ? { type: "resource", uri: input.data.path } : undefined,
  };
}

function rememberResourceRead(
  part: ModelPart,
  pendingResourcesByToolCallId: PendingResourcesByToolCallId,
): void {
  const decision = decodeResourceReadCallForStorage(part);
  if (decision.kind === "not-read") return;
  const pending = pendingResourcesByToolCallId.get(decision.toolCallId) ?? [];
  pending.push(decision.resource);
  pendingResourcesByToolCallId.set(decision.toolCallId, pending);
}

function consumeResourceRead(
  part: ModelPart,
  pendingResourcesByToolCallId: PendingResourcesByToolCallId,
): StoredResourcePartV1 | undefined {
  if (part.type !== "tool-result" || part.toolName !== "read") return undefined;
  const pending = pendingResourcesByToolCallId.get(part.toolCallId);
  const resource = pending?.shift();
  if (pending?.length === 0) pendingResourcesByToolCallId.delete(part.toolCallId);
  return resource;
}

function restoreResourceReadResult(
  part: ModelPart,
  resource: StoredResourcePartV1 | undefined,
): ModelPart | object {
  if (part.type !== "tool-result" || resource === undefined || part.output.type !== "content") {
    return part;
  }
  const value = part.output.value.map((output) => resourceFromReadFilePart(output, resource));
  return { ...part, output: { ...part.output, value } };
}

function projectResourceReadResultsForStorage(
  messages: readonly {
    readonly message: unknown;
    readonly reconstructResourceReads: boolean;
  }[],
): unknown[] {
  const pendingResourcesByToolCallId: PendingResourcesByToolCallId = new Map();

  return messages.map(({ message, reconstructResourceReads }) => {
    if (!reconstructResourceReads) return message;
    const decoded = modelMessageSchema.safeParse(message);
    if (!decoded.success || typeof decoded.data.content === "string") return message;

    const content = decoded.data.content.map((part) => {
      rememberResourceRead(part, pendingResourcesByToolCallId);
      return restoreResourceReadResult(
        part,
        consumeResourceRead(part, pendingResourcesByToolCallId),
      );
    });
    return { ...decoded.data, content };
  });
}

function byteBackedProviderFile(part: ModelFilePart): Uint8Array | null {
  const fileData = part.data;
  const data =
    typeof fileData === "object" &&
    fileData !== null &&
    "type" in fileData &&
    fileData.type === "data"
      ? fileData.data
      : fileData;
  if (typeof data === "string") return Buffer.from(data, "base64");
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

async function abandonProviderFileUpload(input: {
  readonly blobStore: Pick<BlobStore, "delete">;
  readonly target: Parameters<BlobStore["delete"]>[0];
}): Promise<StoredMessageProjectionError> {
  const deletionError = (await input.blobStore.delete(input.target)).match({
    ok: () => null,
    err: (error) => error,
  });
  return new StoredMessageProjectionError({
    message: deletionError
      ? `Provider file persistence was abandoned; upload cleanup failed: ${deletionError.message}`
      : "Provider file persistence was abandoned",
  });
}

async function persistProviderFile(input: {
  readonly part: ModelFilePart;
  readonly blobStore: Pick<BlobStore, "startUpload" | "delete">;
  readonly shouldAbandon?: () => boolean;
  readonly retainUploadedFile: (
    file: StoredFilePartV1,
  ) => ResultType<void, StoredMessageProjectionError>;
}): Promise<ResultType<StoredFilePartV1, StoredMessageProjectionError>> {
  if (input.shouldAbandon?.()) {
    return Result.err(
      new StoredMessageProjectionError({ message: "Provider file persistence was abandoned" }),
    );
  }
  const bytes = byteBackedProviderFile(input.part);
  if (bytes === null) {
    return Result.err(
      new StoredMessageProjectionError({
        message: "Provider file content is not backed by durable byte data",
      }),
    );
  }
  return Result.gen(async function* () {
    const upload = yield* Result.await(
      input.blobStore
        .startUpload({ source: bytes, retention: { kind: "durable" } })
        .then((started) =>
          started.mapError(
            (error) =>
              new StoredMessageProjectionError({
                message: `Provider file upload could not start: ${error.message}`,
              }),
          ),
        ),
    );
    if (input.shouldAbandon?.()) {
      return Result.err(
        await abandonProviderFileUpload({
          blobStore: input.blobStore,
          target: upload.handle,
        }),
      );
    }
    const blob = yield* Result.await(
      upload.completion.then((completed) =>
        completed.mapError(
          (error) =>
            new StoredMessageProjectionError({
              message: `Provider file upload failed: ${error.message}`,
            }),
        ),
      ),
    );
    if (input.shouldAbandon?.()) {
      return Result.err(
        await abandonProviderFileUpload({ blobStore: input.blobStore, target: blob }),
      );
    }
    const file = {
      type: "blob" as const,
      blob,
      mediaType: input.part.mediaType,
      filename: defaultStoredBlobFilename({ blob, filename: input.part.filename }),
    };
    const retentionError = input.retainUploadedFile(file).match({
      ok: () => null,
      err: (error) => error,
    });
    if (retentionError) {
      return Result.err(
        await settleUnretainedProviderFile({
          blobStore: input.blobStore,
          file,
          retentionError,
        }),
      );
    }
    return Result.ok(file);
  });
}

async function settleUnretainedProviderFile(input: {
  readonly blobStore: Pick<BlobStore, "delete">;
  readonly file: StoredFilePartV1;
  readonly retentionError: StoredMessageProjectionError;
}): Promise<StoredMessageProjectionError> {
  const deleted = await input.blobStore.delete(input.file.blob);
  return deleted.match({
    ok: () => input.retentionError,
    err: (error) =>
      new StoredMessageProjectionError({
        message: `${input.retentionError.message}; uploaded blob cleanup failed: ${error.message}`,
      }),
  });
}

async function persistProviderToolResult(input: {
  readonly part: ModelToolResultPart;
  readonly blobStore: Pick<BlobStore, "startUpload" | "delete">;
  readonly shouldAbandon?: () => boolean;
  readonly retainUploadedFile: (
    file: StoredFilePartV1,
  ) => ResultType<void, StoredMessageProjectionError>;
  readonly uploadedFiles: StoredFilePartV1[];
}): Promise<ResultType<object, StoredMessageProjectionError>> {
  if (input.part.output.type !== "content") return Result.ok(input.part);
  const value: object[] = [];
  for (const output of input.part.output.value) {
    if (output.type !== "file") {
      value.push(output);
      continue;
    }
    const decision = await persistProviderFile({ ...input, part: output });
    const failure = decision.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    decision.match({
      ok: (file) => {
        input.uploadedFiles.push(file);
        value.push(file);
      },
      err: () => undefined,
    });
  }
  return Result.ok({ ...input.part, output: { ...input.part.output, value } });
}

async function persistProviderPart(input: {
  readonly part: ModelPart;
  readonly blobStore: Pick<BlobStore, "startUpload" | "delete">;
  readonly shouldAbandon?: () => boolean;
  readonly retainUploadedFile: (
    file: StoredFilePartV1,
  ) => ResultType<void, StoredMessageProjectionError>;
  readonly uploadedFiles: StoredFilePartV1[];
}): Promise<ResultType<object, StoredMessageProjectionError>> {
  if (input.part.type === "file") {
    const stored = await persistProviderFile({ ...input, part: input.part });
    const failure = stored.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    return stored.map((file) => {
      input.uploadedFiles.push(file);
      return file;
    });
  }
  if (input.part.type === "tool-result") {
    return persistProviderToolResult({ ...input, part: input.part });
  }
  return Result.ok(input.part);
}

async function persistProviderMessage(input: {
  readonly message: ModelMessage | StoredMessageV1;
  readonly reconstructResourceReads: boolean;
  readonly pendingResourcesByToolCallId: PendingResourcesByToolCallId;
  readonly blobStore: Pick<BlobStore, "startUpload" | "delete">;
  readonly shouldAbandon?: () => boolean;
  readonly retainUploadedFile: (
    file: StoredFilePartV1,
  ) => ResultType<void, StoredMessageProjectionError>;
  readonly uploadedFiles: StoredFilePartV1[];
}): Promise<ResultType<StoredMessageV1, StoredMessageProjectionError>> {
  const alreadyStored = normalizeStoredMessagesV1([input.message]);
  if (alreadyStored?.[0]) {
    observeStoredProviderResourceReads(input);
    return Result.ok(alreadyStored[0]);
  }
  const decoded = decodeProviderMessageForPersistence(input.message);
  const decodeFailure = decoded.match({ ok: () => null, err: (error) => error });
  if (decodeFailure) return Result.err(decodeFailure);
  const providerMessage = decoded.match({ ok: (message) => message, err: () => null });
  if (providerMessage === null) {
    return Result.err(
      new StoredMessageProjectionError({ message: "Provider message decoding returned no value" }),
    );
  }
  if (typeof providerMessage.content === "string") {
    return projectStoredMessagesV1([providerMessage]).map((messages) => messages[0]!);
  }
  const content: object[] = [];
  for (const part of providerMessage.content) {
    if (input.reconstructResourceReads) {
      rememberResourceRead(part, input.pendingResourcesByToolCallId);
      const resource = consumeResourceRead(part, input.pendingResourcesByToolCallId);
      if (resource !== undefined) {
        content.push(restoreResourceReadResult(part, resource));
        continue;
      }
    }
    const persisted = await persistProviderPart({ ...input, part });
    const failure = persisted.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    persisted.match({ ok: (value) => content.push(value), err: () => undefined });
  }
  return projectStoredMessagesV1([{ ...providerMessage, content }]).map((messages) => messages[0]!);
}

function observeStoredProviderResourceReads(input: {
  readonly message: ModelMessage | StoredMessageV1;
  readonly reconstructResourceReads: boolean;
  readonly pendingResourcesByToolCallId: PendingResourcesByToolCallId;
}): void {
  if (!input.reconstructResourceReads) return;
  const provider = decodeProviderMessageForPersistence(input.message).match({
    ok: (message) => message,
    err: () => null,
  });
  if (!provider || typeof provider.content === "string") return;
  for (const part of provider.content) {
    rememberResourceRead(part, input.pendingResourcesByToolCallId);
    consumeResourceRead(part, input.pendingResourcesByToolCallId);
  }
}

async function projectMessagesWithDurableProviderFiles(input: {
  readonly messages: readonly {
    readonly message: ModelMessage | StoredMessageV1;
    readonly reconstructResourceReads: boolean;
  }[];
  readonly blobStore: Pick<BlobStore, "startUpload" | "delete">;
  readonly shouldAbandon?: () => boolean;
  readonly retainUploadedFile: (
    file: StoredFilePartV1,
  ) => ResultType<void, StoredMessageProjectionError>;
}): Promise<ResultType<StoredMessagePersistenceProjectionV1, StoredMessageProjectionError>> {
  const uploadedFiles: StoredFilePartV1[] = [];
  const pendingResourcesByToolCallId: PendingResourcesByToolCallId = new Map();
  const candidates: StoredMessageV1[] = [];
  for (const candidate of input.messages) {
    const persisted = await persistProviderMessage({
      ...candidate,
      blobStore: input.blobStore,
      ...(input.shouldAbandon ? { shouldAbandon: input.shouldAbandon } : {}),
      retainUploadedFile: input.retainUploadedFile,
      pendingResourcesByToolCallId,
      uploadedFiles,
    });
    const failure = persisted.match({ ok: () => null, err: (error) => error });
    if (failure) return Result.err(failure);
    persisted.match({ ok: (value) => candidates.push(value), err: () => undefined });
  }
  return Result.ok({ messages: candidates, uploadedFiles });
}

/** Keeps structured durable identity beside provider-only message representations. */
export function createStoredMessageIdentityProjectionV1(): StoredMessageIdentityProjectionV1 {
  const storedByProviderMessage = new WeakMap<object, StoredMessageV1>();
  const storedByProviderFileData = new WeakMap<object, RememberedProviderMessage>();

  const providerFileData = (message: ModelMessage | StoredMessageV1): object[] => {
    if (typeof message.content === "string") return [];
    const identities: object[] = [];
    const rememberFile = (part: ProviderFileIdentityPart): void => {
      if (part.type !== "file" || typeof part.data !== "object" || part.data === null) return;
      identities.push(part.data);
    };
    for (const part of message.content) {
      rememberFile(part);
      if (part.type !== "tool-result" || part.output.type !== "content") continue;
      for (const output of part.output.value) rememberFile(output);
    }
    return identities;
  };

  const rememberProviderFileData = (
    providerMessage: ModelMessage,
    storedMessage: StoredMessageV1,
  ): void => {
    for (const identity of providerFileData(providerMessage)) {
      const existing = storedByProviderFileData.get(identity);
      if (existing?.kind === "ambiguous") continue;
      if (existing?.kind === "remembered") {
        if (isDeepStrictEqual(existing.message, storedMessage)) continue;
        storedByProviderFileData.set(identity, { kind: "ambiguous" });
        continue;
      }
      storedByProviderFileData.set(identity, { kind: "remembered", message: storedMessage });
    }
  };

  const findRememberedProviderMessage = (
    providerMessage: ModelMessage | StoredMessageV1,
  ): StoredMessageV1 | undefined => {
    let candidate: StoredMessageV1 | undefined;
    for (const identity of providerFileData(providerMessage)) {
      const remembered = storedByProviderFileData.get(identity);
      if (remembered?.kind !== "remembered") continue;
      if (!candidate) {
        candidate = remembered.message;
        continue;
      }
      if (!isDeepStrictEqual(candidate, remembered.message)) return undefined;
    }
    return candidate;
  };

  const rememberMessages = (
    providerMessages: readonly ModelMessage[],
    storedMessages: readonly StoredMessageV1[],
  ): void => {
    for (let index = 0; index < providerMessages.length; index += 1) {
      const providerMessage = providerMessages[index];
      const storedMessage = storedMessages[index];
      if (!providerMessage || !storedMessage) continue;
      storedByProviderMessage.set(providerMessage, storedMessage);
      rememberProviderFileData(providerMessage, storedMessage);
    }
  };

  const projectCandidate = (providerMessage: ModelMessage | StoredMessageV1) => {
    const remembered =
      storedByProviderMessage.get(providerMessage) ??
      findRememberedProviderMessage(providerMessage);
    return {
      message: remembered ?? providerMessage,
      reconstructResourceReads: remembered === undefined,
    };
  };

  return {
    remember(providerMessages, storedMessages) {
      if (providerMessages.length !== storedMessages.length) {
        return Result.err(
          new StoredMessageProjectionError({
            message: "Provider and stored message identity sequences are not aligned",
          }),
        );
      }
      rememberMessages(providerMessages, storedMessages);
      return Result.ok(undefined);
    },
    project(providerMessages) {
      return projectStoredMessagesV1(
        projectResourceReadResultsForStorage(providerMessages.map(projectCandidate)),
      );
    },
    async projectForPersistence(input) {
      return projectMessagesWithDurableProviderFiles({
        messages: input.providerMessages.map(projectCandidate),
        blobStore: input.blobStore,
        ...(input.shouldAbandon ? { shouldAbandon: input.shouldAbandon } : {}),
        retainUploadedFile: input.retainUploadedFile,
      });
    },
  };
}

/**
 * Projects already-resolved request content into the strict durable message contract.
 * Inline bytes, data URLs, upload handles, and unknown message parts are rejected.
 */
export function projectStoredMessagesV1(
  messages: readonly unknown[],
): ResultType<StoredMessageV1[], StoredMessageProjectionError> {
  const normalized = normalizeStoredMessagesV1(messages);
  if (normalized === null) {
    return Result.err(
      new StoredMessageProjectionError({
        message: "Messages do not satisfy the resolved stored-message contract",
      }),
    );
  }
  return Result.ok(normalized);
}

function materializationFailure(
  stage: StoredMessageMaterializationError["stage"],
  message: string,
): StoredMessageMaterializationError {
  return new StoredMessageMaterializationError({ stage, message });
}

async function materializeBlobPart(input: {
  readonly blobStore: BlobStore;
  readonly blob: BlobRefV1;
}): Promise<ResultType<Uint8Array, StoredMessageMaterializationError>> {
  const opened = await input.blobStore.open(input.blob);
  const openFailure = opened.match({ ok: () => null, err: (error) => error });
  if (openFailure) {
    return Result.err(materializationFailure("open", openFailure.message));
  }
  const read = opened.match({ ok: (value) => value, err: () => null });
  if (read === null) {
    return Result.err(materializationFailure("open", "Blob storage returned no readable object"));
  }
  return (await materializeBlobRead(read)).mapError((error) =>
    materializationFailure("read", error.message),
  );
}

/** Opens and reads every reference through EOF so storage verifies its metadata and content digest. */
export async function verifyStoredBlobReferencesV1(input: {
  readonly references: readonly BlobRefV1[];
  readonly blobStore: Pick<BlobStore, "open">;
}): Promise<ResultType<void, StoredMessageMaterializationError>> {
  return Result.gen(async function* () {
    for (const blob of input.references) {
      const read = yield* Result.await(
        input.blobStore
          .open(blob)
          .then((opened) =>
            opened.mapError((error) => materializationFailure("open", error.message)),
          ),
      );
      yield* Result.await(
        materializeBlobRead(read).then((materialized) =>
          materialized
            .map(() => undefined)
            .mapError((error) => materializationFailure("read", error.message)),
        ),
      );
    }
    return Result.ok(undefined);
  });
}

type StoredUserMessage = Extract<StoredMessageV1, { readonly role: "user" }>;
type StoredAssistantMessage = Extract<StoredMessageV1, { readonly role: "assistant" }>;
type StoredToolMessage = Extract<StoredMessageV1, { readonly role: "tool" }>;
type StoredUserPart = Exclude<StoredUserMessage["content"], string>[number];
type StoredAssistantPart = Exclude<StoredAssistantMessage["content"], string>[number];
type StoredToolPart = StoredToolMessage["content"][number];
type StoredPart = StoredUserPart | StoredAssistantPart | StoredToolPart;
type StoredToolResultPart = Extract<StoredPart, { readonly type: "tool-result" }>;

function markerValue(value: string): string {
  return value.replace(/[\n\r"\\]/gu, "_");
}

export function formatStoredResourceMarkerV1(part: StoredResourcePartV1): string {
  const fields = [
    `uri="${markerValue(part.uri)}"`,
    part.filename === undefined ? null : `filename="${markerValue(part.filename)}"`,
    part.mediaType === undefined ? null : `mime="${markerValue(part.mediaType)}"`,
    part.size === undefined ? null : `size=${part.size}`,
  ].filter((field): field is string => field !== null);
  return `[attachment ${fields.join(" ")}]`;
}

const RESOURCE_INLINE_GUIDANCE =
  "Use resource.materialize to write this resource into the working directory, transform it to a supported size or format, and then consume the transformed file.";

function resourceInlineErrorCode(error: ResourceAccessError): string {
  switch (error._tag) {
    case "ResourceInvalidUri":
      return "invalid_uri";
    case "ResourceNotFound":
      return "not_found";
    case "ResourceOriginUnavailable":
      return "origin_unavailable";
    case "ResourceUnsupportedClassification":
      return "unsupported";
    case "ResourceTooLarge":
      return "too_large";
    case "ResourceCacheUnavailable":
      return "cache_unavailable";
    case "ResourceIntegrityFailure":
      return "integrity_failure";
    case "ResourceCancelled":
      return "cancelled";
    case "ResourceAlreadyExists":
      return "already_exists";
    case "ResourceWriteFailed":
      return "write_failed";
  }
}

function resourceInlineGuidance(input: {
  readonly part: StoredResourcePartV1;
  readonly code: string;
  readonly limit?: number;
  readonly guidance?: string;
}): object[] {
  const fields = [
    `uri="${markerValue(input.part.uri)}"`,
    `code="${input.code}"`,
    input.limit === undefined ? null : `limit=${input.limit}`,
  ].filter((field): field is string => field !== null);
  return [
    { type: "text", text: `[resource_inline_error ${fields.join(" ")}]` },
    { type: "text", text: input.guidance ?? RESOURCE_INLINE_GUIDANCE },
  ];
}

function omittedImageParts(part: StoredResourcePartV1): object[] {
  return [
    { type: "text", text: formatStoredResourceMarkerV1(part) },
    ...resourceInlineGuidance({
      part,
      code: "too_large",
      limit: RESOURCE_IMAGE_INLINE_MAX_BYTES,
      guidance:
        "Image exceeds the 1 MiB automatic inline limit. Use resource.materialize to save the original, resize a copy to at most 1 MiB, and read the resized copy. Keep the original for editing or generation; do not read the full-size original into model context.",
    }),
  ];
}

function resourceKindFromMediaType(mediaType: string | undefined): "image" | "pdf" | null {
  if (mediaType?.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "pdf";
  return null;
}

function providerSupportsResourceKind(
  target: StoredResourceProviderTarget,
  resourceKind: "image" | "pdf",
): boolean {
  return resourceKind === "image"
    ? target.supportsImage
    : target.family === "ai-sdk" && target.supportsPdf;
}

function resourceAccessDecision<T>(
  result: ResultType<T, ResourceAccessError>,
):
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: ResourceAccessError } {
  return result.match<
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "error"; readonly error: ResourceAccessError }
  >({
    ok: (value) => ({ kind: "value", value }),
    err: (error) => ({ kind: "error", error }),
  });
}

function expectedResourceErrorParts(input: {
  readonly marker: object;
  readonly part: StoredResourcePartV1;
  readonly error: ResourceAccessError;
}): object[] {
  return [
    input.marker,
    ...resourceInlineGuidance({
      part: input.part,
      code: resourceInlineErrorCode(input.error),
      ...(input.error._tag === "ResourceTooLarge" ? { limit: input.error.limit } : {}),
    }),
  ];
}

async function materializeStoredResource(input: {
  readonly part: StoredResourcePartV1;
  readonly resourceAccess: Pick<ResourceAccess, "describe" | "open"> | undefined;
  readonly target: StoredResourceProviderTarget | undefined;
  readonly toolResult?: boolean;
}): Promise<object[]> {
  const marker = {
    type: "text",
    text: formatStoredResourceMarkerV1(input.part),
  };
  if (!input.target) return [marker];
  if (!input.resourceAccess) {
    return [
      marker,
      ...resourceInlineGuidance({
        part: input.part,
        code: "access_unavailable",
      }),
    ];
  }

  const described = resourceAccessDecision(input.resourceAccess.describe(input.part.uri));
  if (described.kind === "error") {
    return expectedResourceErrorParts({
      marker,
      part: input.part,
      error: described.error,
    });
  }
  const descriptor = described.value;

  const filename = descriptor.filename ?? input.part.filename;
  const detectedKind = resourceKindFromMediaType(descriptor.detectedMediaType);
  if (descriptor.detectedMediaType && detectedKind === null) return [marker];
  if (!descriptor.detectedMediaType && hasResourceTextFilenameHint(filename)) return [marker];

  const knownKind = resourceKindFromMediaType(
    descriptor.detectedMediaType ?? descriptor.declaredMediaType ?? input.part.mediaType,
  );
  if (detectedKind && !providerSupportsResourceKind(input.target, detectedKind)) {
    return [marker, ...resourceInlineGuidance({ part: input.part, code: "unsupported_provider" })];
  }

  const opened = resourceAccessDecision(
    await input.resourceAccess.open(input.part.uri, {
      maxBytes: RESOURCE_MODEL_INLINE_MAX_BYTES,
      modelImage: input.target.supportsImage,
      expected: "any",
    }),
  );
  if (opened.kind === "error") {
    if (knownKind === "image" && opened.error._tag === "ResourceTooLarge")
      return omittedImageParts(input.part);
    return expectedResourceErrorParts({
      marker,
      part: input.part,
      error: opened.error,
    });
  }
  const read = opened.value;
  const verifiedKind =
    read.classification.kind === "image" || read.classification.kind === "pdf"
      ? read.classification.kind
      : null;
  if (verifiedKind === null) {
    await cancelVerifiedResourceRead(read);
    return [marker];
  }
  if (!providerSupportsResourceKind(input.target, verifiedKind)) {
    await cancelVerifiedResourceRead(read);
    return [
      marker,
      ...resourceInlineGuidance({
        part: input.part,
        code: "unsupported_provider",
      }),
    ];
  }
  if (verifiedKind === "image" && read.blob.byteLength > RESOURCE_IMAGE_INLINE_MAX_BYTES) {
    await cancelVerifiedResourceRead(read);
    return omittedImageParts(input.part);
  }

  const consumed = resourceAccessDecision(await consumeVerifiedResourceRead(read));
  if (consumed.kind === "error") {
    return expectedResourceErrorParts({
      marker,
      part: input.part,
      error: consumed.error,
    });
  }
  const verifiedMediaType = read.classification.mediaType;
  if (!verifiedMediaType) {
    return [marker, ...resourceInlineGuidance({ part: input.part, code: "unsupported" })];
  }

  const data = input.toolResult
    ? { type: "data" as const, data: Buffer.from(consumed.value).toString("base64") }
    : consumed.value;
  const file = {
    type: "file" as const,
    data,
    mediaType: verifiedMediaType,
    ...(input.part.filename === undefined ? {} : { filename: input.part.filename }),
  };
  if (!read.imagePreview) return [marker, file];
  const preview = read.imagePreview;
  return [
    marker,
    {
      type: "text",
      text: `Resized preview (${preview.originalWidth}×${preview.originalHeight} → ${preview.width}×${preview.height}). Small text and fine details may be lost. Use resource.materialize with ${input.part.uri} to access the original if needed.`,
    },
    file,
  ];
}

async function materializeStoredFile(input: {
  readonly part: ReturnType<typeof storedFilePartV1Schema.parse>;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
  readonly toolResult?: boolean;
}): Promise<ResultType<object, StoredMessageMaterializationError>> {
  const part = input.part;
  const cacheKey = `${part.blob.objectId}:${part.blob.sha256}:${part.blob.byteLength}`;
  let pending = input.cache.get(cacheKey);
  if (pending === undefined) {
    pending = materializeBlobPart({
      blobStore: input.blobStore,
      blob: part.blob,
    });
    input.cache.set(cacheKey, pending);
  }
  return (await pending).map((bytes) => ({
    type: "file" as const,
    data: input.toolResult
      ? { type: "data" as const, data: Buffer.from(bytes).toString("base64") }
      : bytes,
    mediaType: part.mediaType,
    ...(part.filename === undefined ? {} : { filename: part.filename }),
  }));
}

async function materializeToolResult(input: {
  readonly part: StoredToolResultPart;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
  readonly resourceAccess: Pick<ResourceAccess, "describe" | "open"> | undefined;
  readonly resourceTarget: StoredResourceProviderTarget | undefined;
}): Promise<ResultType<object, StoredMessageMaterializationError>> {
  if (input.part.output.type !== "content") return Result.ok(input.part);
  const value: object[] = [];
  for (const part of input.part.output.value) {
    if (part.type !== "blob") {
      if (part.type === "resource") {
        value.push(
          ...(await materializeStoredResource({
            part,
            resourceAccess: input.resourceAccess,
            target: input.resourceTarget,
            toolResult: true,
          })),
        );
      } else {
        value.push(part);
      }
      continue;
    }
    const materialized = await materializeStoredFile({ ...input, part, toolResult: true });
    const failure = materialized.match({
      ok: () => null,
      err: (error) => error,
    });
    if (failure) return Result.err(failure);
    materialized.match({
      ok: (file) => value.push(file),
      err: () => undefined,
    });
  }
  return Result.ok({ ...input.part, output: { ...input.part.output, value } });
}

async function materializeStoredPart(input: {
  readonly part: StoredPart;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
  readonly resourceAccess: Pick<ResourceAccess, "describe" | "open"> | undefined;
  readonly resourceTarget: StoredResourceProviderTarget | undefined;
}): Promise<ResultType<object[], StoredMessageMaterializationError>> {
  if (input.part.type === "blob") {
    return (await materializeStoredFile({ ...input, part: input.part })).map((part) => [part]);
  }
  if (input.part.type === "resource") {
    return Result.ok(
      await materializeStoredResource({
        part: input.part,
        resourceAccess: input.resourceAccess,
        target: input.resourceTarget,
      }),
    );
  }
  if (input.part.type === "tool-result") {
    return (await materializeToolResult({ ...input, part: input.part })).map((part) => [part]);
  }
  return Result.ok([input.part]);
}

async function materializeStoredMessage(input: {
  readonly message: StoredMessageV1;
  readonly blobStore: BlobStore;
  readonly cache: Map<string, Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>>;
  readonly resourceAccess: Pick<ResourceAccess, "describe" | "open"> | undefined;
  readonly resourceTarget: StoredResourceProviderTarget | undefined;
}): Promise<ResultType<ModelMessage, StoredMessageMaterializationError>> {
  if (typeof input.message.content === "string") {
    const decoded = modelMessageSchema.safeParse(input.message);
    if (decoded.success) return Result.ok(decoded.data);
    return Result.err(
      new StoredMessageMaterializationError({
        stage: "decode",
        message: "Stored text message does not satisfy the provider message contract",
      }),
    );
  }
  const content: object[] = [];
  for (const part of input.message.content) {
    const materialized = await materializeStoredPart({ ...input, part });
    const decision = materialized.match<
      | { readonly kind: "value"; readonly value: object[] }
      | {
          readonly kind: "error";
          readonly error: StoredMessageMaterializationError;
        }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (error) => ({ kind: "error", error }),
    });
    if (decision.kind === "error") return Result.err(decision.error);
    content.push(...decision.value);
  }
  const decoded = modelMessageSchema.safeParse({ ...input.message, content });
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new StoredMessageMaterializationError({
      stage: "decode",
      message: "Materialized message does not satisfy the provider message contract",
    }),
  );
}

/** Materializes and verifies every durable blob before returning provider-facing messages. */
export async function materializeStoredMessagesV1(input: {
  readonly messages: readonly StoredMessageV1[];
  readonly blobStore: BlobStore;
  readonly identityProjection?: StoredMessageIdentityProjectionV1;
  readonly resourceAccess?: Pick<ResourceAccess, "describe" | "open">;
  readonly resourceTarget?: StoredResourceProviderTarget;
}): Promise<ResultType<ModelMessage[], StoredMessageMaterializationFailure>> {
  const projected = projectStoredMessagesV1(input.messages);
  const projectionFailure = projected.match({
    ok: () => null,
    err: (error) => error,
  });
  if (projectionFailure) return Result.err(projectionFailure);
  const messages = projected.match({ ok: (value) => value, err: () => null });
  if (messages === null) {
    return Result.err(
      new StoredMessageProjectionError({
        message: "Stored messages could not be projected",
      }),
    );
  }

  const output: ModelMessage[] = [];
  const cache = new Map<
    string,
    Promise<ResultType<Uint8Array, StoredMessageMaterializationError>>
  >();
  for (const message of messages) {
    const materialized = await materializeStoredMessage({
      message,
      blobStore: input.blobStore,
      cache,
      resourceAccess: input.resourceAccess,
      resourceTarget: input.resourceTarget,
    });
    const failure = materialized.match({
      ok: () => null,
      err: (error) => error,
    });
    if (failure) return Result.err(failure);
    materialized.match({
      ok: (value) => output.push(value),
      err: () => undefined,
    });
  }
  const remembered = input.identityProjection?.remember(output, messages);
  const rememberFailure = remembered?.match({
    ok: () => null,
    err: (error) => error,
  });
  if (rememberFailure) return Result.err(rememberFailure);
  return Result.ok(output);
}
