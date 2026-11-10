import {
  materializeBlobRead,
  BlobObjectAbsent,
  BlobObjectExpired,
  type BlobResolveError,
  type BlobDeleteError,
  type BlobReadError,
  type BlobReadTerminalError,
  type BlobRefV1,
  type BlobStore,
  type BlobUploadStartError,
  type BlobWriteError,
} from "@stanley2058/lilac-blob-storage";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  DurableWorkflowInvariantViolation,
  type DurableWorkflowReadError,
  type DurableWorkflowStore,
} from "./durable-workflow-store";
import {
  decodeWorkflowValueArtifact,
  encodeWorkflowArtifactReference,
  encodeWorkflowValueArtifact,
  workflowValueArtifactFileByteLimit,
  type WorkflowArtifactCodecError,
} from "./workflow-artifact-persistence-codec";
import { sha256 } from "./workflow-definition";
import type { JsonValue, WorkflowArtifactReference } from "./workflow-domain";

export const WORKFLOW_INLINE_VALUE_BYTES = 64 * 1024;
const WORKFLOW_VALUE_ARTIFACT_PREFIX = "workflow-value:";
const WORKFLOW_SOURCE_ARTIFACT_PREFIX = "workflow-source:";
const WORKFLOW_ARTIFACT_STAGING_MS = 10 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

type WorkflowArtifactIoOperation =
  | "lookup-artifact"
  | "register-artifact"
  | "record-publication"
  | "complete-publication"
  | "remove-publication"
  | "adopt-upload"
  | "start-upload"
  | "complete-upload"
  | "open-artifact"
  | "read-artifact"
  | "delete-artifact";

export class WorkflowArtifactInvalidId extends TaggedError("WorkflowArtifactInvalidId")<{
  readonly message: string;
}> {}

export class WorkflowArtifactAbsent extends TaggedError("WorkflowArtifactAbsent")<{
  readonly artifactId: string;
  readonly message: string;
}> {}

export class WorkflowArtifactUnsafePath extends TaggedError("WorkflowArtifactUnsafePath")<{
  readonly artifactId: string;
  readonly location: "root" | "artifact";
  readonly issue: "symlink" | "not-directory" | "not-file" | "escaped-root";
  readonly message: string;
}> {}

export class WorkflowArtifactIoFailed extends TaggedError("WorkflowArtifactIoFailed")<{
  readonly artifactId: string;
  readonly operation: WorkflowArtifactIoOperation;
  readonly code: string;
  readonly message: string;
}> {}

export class WorkflowArtifactFileTooLarge extends TaggedError("WorkflowArtifactFileTooLarge")<{
  readonly artifactId: string;
  readonly maxBytes: number;
  readonly message: string;
}> {}

export class WorkflowArtifactValueTooLarge extends TaggedError("WorkflowArtifactValueTooLarge")<{
  readonly artifactId: string;
  readonly maxBytes: number;
  readonly message: string;
}> {}

export class WorkflowArtifactWriteAndCleanupFailed extends TaggedError(
  "WorkflowArtifactWriteAndCleanupFailed",
)<{
  readonly artifactId: string;
  readonly primary: WorkflowArtifactIoFailed;
  readonly cleanup: WorkflowArtifactIoFailed;
  readonly message: string;
}> {}

export type WorkflowArtifactReadError =
  | WorkflowArtifactInvalidId
  | WorkflowArtifactAbsent
  | WorkflowArtifactUnsafePath
  | WorkflowArtifactIoFailed
  | WorkflowArtifactFileTooLarge
  | WorkflowArtifactCodecError;

export type WorkflowArtifactWriteError =
  | WorkflowArtifactInvalidId
  | WorkflowArtifactAbsent
  | WorkflowArtifactUnsafePath
  | WorkflowArtifactIoFailed
  | WorkflowArtifactFileTooLarge
  | WorkflowArtifactValueTooLarge
  | WorkflowArtifactWriteAndCleanupFailed
  | WorkflowArtifactCodecError;

export function adaptWorkflowArtifactResultToException<
  T,
  E extends WorkflowArtifactReadError | WorkflowArtifactWriteError,
>(result: ResultType<T, E>): T {
  return adaptToolResultToHost(result);
}

function artifactHash(
  artifactId: string,
  prefix: typeof WORKFLOW_VALUE_ARTIFACT_PREFIX | typeof WORKFLOW_SOURCE_ARTIFACT_PREFIX,
): ResultType<string, WorkflowArtifactInvalidId> {
  if (!artifactId.startsWith(prefix)) {
    return Result.err(
      new WorkflowArtifactInvalidId({ message: "Unsupported workflow artifact ID" }),
    );
  }
  const hash = artifactId.slice(prefix.length);
  return HASH_PATTERN.test(hash)
    ? Result.ok(hash)
    : Result.err(new WorkflowArtifactInvalidId({ message: "Invalid workflow artifact ID" }));
}

type BlobFailure =
  | BlobDeleteError
  | BlobReadError
  | BlobReadTerminalError
  | BlobUploadStartError
  | BlobWriteError
  | BlobResolveError
  | DurableWorkflowReadError
  | DurableWorkflowInvariantViolation;

function ioFailure(
  artifactId: string,
  operation: WorkflowArtifactIoOperation,
  error: BlobFailure,
): WorkflowArtifactIoFailed {
  return new WorkflowArtifactIoFailed({
    artifactId,
    operation,
    code: error._tag,
    message: `Workflow artifact ${operation} failed`,
  });
}

async function readArtifactBytes(input: {
  readonly blobStore: BlobStore;
  readonly reference: WorkflowArtifactReference;
  readonly maxBytes: number;
}): Promise<ResultType<Uint8Array, WorkflowArtifactReadError>> {
  if (input.reference.blobRef.byteLength > input.maxBytes) {
    return Result.err(
      new WorkflowArtifactFileTooLarge({
        artifactId: input.reference.artifactId,
        maxBytes: input.maxBytes,
        message: "Workflow artifact exceeds its bounded size",
      }),
    );
  }
  const opened = await input.blobStore.open(input.reference.blobRef);
  return opened
    .mapError((error) => ioFailure(input.reference.artifactId, "open-artifact", error))
    .andThenAsync(async function materialize(read) {
      return (await materializeBlobRead(read)).mapError((error) =>
        ioFailure(input.reference.artifactId, "read-artifact", error),
      );
    });
}

async function deleteUploadedAfterFailure(input: {
  readonly blobStore: BlobStore;
  readonly reference: WorkflowArtifactReference;
  readonly primary: WorkflowArtifactIoFailed;
}): Promise<ResultType<never, WorkflowArtifactWriteError>> {
  const deleted = await input.blobStore.delete(input.reference.blobRef);
  return deleted.match<ResultType<never, WorkflowArtifactWriteError>>({
    ok: () => Result.err(input.primary),
    err: (error) =>
      Result.err(
        new WorkflowArtifactWriteAndCleanupFailed({
          artifactId: input.reference.artifactId,
          primary: input.primary,
          cleanup: ioFailure(input.reference.artifactId, "delete-artifact", error),
          message: "Workflow artifact write and cleanup both failed",
        }),
      ),
  });
}

type WorkflowArtifactPublicationContext = {
  readonly blobStore: BlobStore;
  readonly workflowStore: DurableWorkflowStore;
};

function sameArtifactReference(
  left: WorkflowArtifactReference,
  right: WorkflowArtifactReference,
): boolean {
  return encodeWorkflowArtifactReference(left) === encodeWorkflowArtifactReference(right);
}

async function discardPublication(
  input: WorkflowArtifactPublicationContext,
  reference: WorkflowArtifactReference,
): Promise<ResultType<void, WorkflowArtifactIoFailed>> {
  return Result.gen(async function* () {
    yield* Result.await(
      input.blobStore
        .delete({ version: 1, objectId: reference.blobRef.objectId })
        .then((deleted) =>
          deleted.mapError((error) => ioFailure(reference.artifactId, "delete-artifact", error)),
        ),
    );
    return input.workflowStore
      .removeWorkflowArtifactPublication(reference)
      .mapError((error) => ioFailure(reference.artifactId, "remove-publication", error));
  });
}

async function finishCanonicalPublication(
  input: WorkflowArtifactPublicationContext,
  candidate: WorkflowArtifactReference,
  canonical: WorkflowArtifactReference,
): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactIoFailed>> {
  if (sameArtifactReference(candidate, canonical)) {
    return input.workflowStore
      .removeWorkflowArtifactPublication(candidate)
      .map(() => canonical)
      .mapError((error) => ioFailure(candidate.artifactId, "remove-publication", error));
  }
  return (await discardPublication(input, candidate)).map(() => canonical);
}

async function verifyPublication(
  blobStore: BlobStore,
  reference: WorkflowArtifactReference,
): Promise<ResultType<void, WorkflowArtifactReadError>> {
  const input = { blobStore, reference, maxBytes: reference.blobRef.byteLength };
  if (reference.artifactId.startsWith(WORKFLOW_SOURCE_ARTIFACT_PREFIX)) {
    return (await readWorkflowSourceArtifact(input)).map(() => undefined);
  }
  return (await readWorkflowValueArtifact(input)).map(() => undefined);
}

async function commitAdoptedPublication(
  input: WorkflowArtifactPublicationContext,
  reference: WorkflowArtifactReference,
): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactReadError>> {
  const committed = await Result.gen(async function* () {
    yield* Result.await(verifyPublication(input.blobStore, reference));
    const canonical = yield* input.workflowStore
      .completeWorkflowArtifactPublication(reference, Date.now())
      .mapError((error) => ioFailure(reference.artifactId, "complete-publication", error));
    return await finishCanonicalPublication(input, reference, canonical);
  });
  async function useConcurrentCanonical(
    failure: WorkflowArtifactReadError,
  ): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactReadError>> {
    return Result.gen(async function* () {
      const canonical = yield* input.workflowStore
        .getWorkflowArtifact(reference.artifactId)
        .mapError((error) => ioFailure(reference.artifactId, "lookup-artifact", error));
      if (canonical === null) return Result.err(failure);
      return await finishCanonicalPublication(input, reference, canonical);
    });
  }
  return committed.tryRecoverAsync(useConcurrentCanonical);
}

async function reconcilePublication(
  input: WorkflowArtifactPublicationContext,
  reference: WorkflowArtifactReference,
): Promise<ResultType<WorkflowArtifactReference | null, WorkflowArtifactReadError>> {
  return Result.gen(async function* () {
    const existing = yield* input.workflowStore
      .getWorkflowArtifact(reference.artifactId)
      .mapError((error) => ioFailure(reference.artifactId, "lookup-artifact", error));
    if (existing !== null) return await finishCanonicalPublication(input, reference, existing);

    const adopted = await input.blobStore.adopt({
      version: 1,
      objectId: reference.blobRef.objectId,
    });
    const adoption = adopted.match<
      | { readonly kind: "adopted"; readonly blobRef: BlobRefV1 }
      | { readonly kind: "error"; readonly error: BlobResolveError }
    >({
      ok: (blobRef) => ({ kind: "adopted" as const, blobRef }),
      err: (error) => ({ kind: "error" as const, error }),
    });
    if (adoption.kind === "error") {
      if (
        !(adoption.error instanceof BlobObjectAbsent) &&
        !(adoption.error instanceof BlobObjectExpired)
      ) {
        return Result.err(ioFailure(reference.artifactId, "adopt-upload", adoption.error));
      }
      const canonical = yield* input.workflowStore
        .getWorkflowArtifact(reference.artifactId)
        .mapError((error) => ioFailure(reference.artifactId, "lookup-artifact", error));
      if (canonical !== null) return await finishCanonicalPublication(input, reference, canonical);
      yield* Result.await(discardPublication(input, reference));
      return Result.ok(null);
    }
    const adoptedReference = { artifactId: reference.artifactId, blobRef: adoption.blobRef };
    if (!sameArtifactReference(reference, adoptedReference)) {
      return Result.err(
        new WorkflowArtifactIoFailed({
          artifactId: reference.artifactId,
          operation: "adopt-upload",
          code: "WORKFLOW_PUBLICATION_REFERENCE_MISMATCH",
          message: "Workflow artifact publication does not match its staged upload",
        }),
      );
    }
    return await commitAdoptedPublication(input, adoptedReference);
  });
}

export async function maintainWorkflowArtifactPublications(
  input: WorkflowArtifactPublicationContext & { readonly limit?: number },
): Promise<
  ResultType<
    { readonly inspected: number; readonly recovered: number; readonly discarded: number },
    WorkflowArtifactReadError
  >
> {
  return Result.gen(async function* () {
    const publications = yield* input.workflowStore
      .listWorkflowArtifactPublications(input.limit ?? 100)
      .mapError((error) => ioFailure("workflow-publications", "lookup-artifact", error));
    let recovered = 0;
    let discarded = 0;
    let firstFailure: WorkflowArtifactReadError | undefined;
    for (const reference of publications) {
      const reconciled = await reconcilePublication(input, reference);
      reconciled.match({
        ok: (canonical) => {
          if (canonical === null) discarded++;
          else recovered++;
        },
        err: (error) => {
          firstFailure ??= error;
        },
      });
    }
    if (firstFailure !== undefined) return Result.err(firstFailure);
    return Result.ok({ inspected: publications.length, recovered, discarded });
  });
}

async function publishArtifact(
  input: WorkflowArtifactPublicationContext & {
    readonly artifactId: string;
    readonly bytes: Uint8Array;
    readonly createdAt: number;
    readonly verify: (
      reference: WorkflowArtifactReference,
    ) => Promise<ResultType<void, WorkflowArtifactReadError>>;
  },
): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactWriteError>> {
  return Result.gen(async function* () {
    const existing = yield* input.workflowStore
      .getWorkflowArtifact(input.artifactId)
      .mapError((error) => ioFailure(input.artifactId, "lookup-artifact", error));
    if (existing !== null) return (await input.verify(existing)).map(() => existing);

    const upload = yield* Result.await(
      input.blobStore
        .startStagedUpload({
          source: input.bytes,
          stagingExpiresAt: Date.now() + WORKFLOW_ARTIFACT_STAGING_MS,
          expectedSha256: sha256(input.bytes),
          expectedByteLength: input.bytes.byteLength,
        })
        .then((started) =>
          started.mapError((error) => ioFailure(input.artifactId, "start-upload", error)),
        ),
    );
    const blobRef = yield* Result.await(
      upload.completion.then((completed) =>
        completed.mapError((error) => ioFailure(input.artifactId, "complete-upload", error)),
      ),
    );
    const reference = { artifactId: input.artifactId, blobRef };
    const recorded = input.workflowStore.beginWorkflowArtifactPublication(
      reference,
      input.createdAt,
    );
    const recordFailure = recorded.match({ ok: () => null, err: (error) => error });
    if (recordFailure !== null) {
      return await deleteUploadedAfterFailure({
        blobStore: input.blobStore,
        reference,
        primary: ioFailure(input.artifactId, "record-publication", recordFailure),
      });
    }
    const canonical = yield* Result.await(reconcilePublication(input, reference));
    if (canonical === null) {
      return Result.err(
        new WorkflowArtifactAbsent({
          artifactId: input.artifactId,
          message: "Workflow artifact staging expired before publication",
        }),
      );
    }
    return (await input.verify(canonical)).map(() => canonical);
  });
}

export async function writeWorkflowValueArtifact(input: {
  readonly blobStore: BlobStore;
  readonly workflowStore: DurableWorkflowStore;
  readonly value: JsonValue;
  readonly maxBytes: number;
  readonly now?: () => number;
}): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactWriteError>> {
  const encoded = encodeWorkflowValueArtifact(input.value);
  const artifactId = `${WORKFLOW_VALUE_ARTIFACT_PREFIX}${encoded.payloadHash}`;
  if (encoded.payloadBytes > input.maxBytes) {
    return Result.err(
      new WorkflowArtifactValueTooLarge({
        artifactId,
        maxBytes: input.maxBytes,
        message: `Workflow value exceeds ${input.maxBytes} bytes`,
      }),
    );
  }
  const bytes = new TextEncoder().encode(encoded.encoded);
  return publishArtifact({
    blobStore: input.blobStore,
    workflowStore: input.workflowStore,
    artifactId,
    bytes,
    createdAt: (input.now ?? Date.now)(),
    verify: async (reference) =>
      (
        await readWorkflowValueArtifact({
          blobStore: input.blobStore,
          reference,
          maxBytes: input.maxBytes,
        })
      ).map(() => undefined),
  });
}

export async function readWorkflowValueArtifact(input: {
  readonly blobStore: BlobStore;
  readonly reference: WorkflowArtifactReference;
  readonly maxBytes: number;
}): Promise<ResultType<JsonValue, WorkflowArtifactReadError>> {
  const expectedHash = artifactHash(input.reference.artifactId, WORKFLOW_VALUE_ARTIFACT_PREFIX);
  return expectedHash.andThenAsync(async function readValue(hash) {
    const bytes = await readArtifactBytes({
      blobStore: input.blobStore,
      reference: input.reference,
      maxBytes: workflowValueArtifactFileByteLimit(input.maxBytes),
    });
    return bytes.andThen((content) =>
      decodeWorkflowValueArtifact({
        encoded: new TextDecoder().decode(content),
        expectedHash: hash,
        maxValueBytes: input.maxBytes,
        artifactId: input.reference.artifactId,
      }).map((decoded) => decoded.value),
    );
  });
}

export async function writeWorkflowSourceArtifact(input: {
  readonly blobStore: BlobStore;
  readonly workflowStore: DurableWorkflowStore;
  readonly source: string;
  readonly sourceSha256: string;
  readonly maxBytes: number;
  readonly now?: () => number;
}): Promise<ResultType<WorkflowArtifactReference, WorkflowArtifactWriteError>> {
  const artifactId = `${WORKFLOW_SOURCE_ARTIFACT_PREFIX}${input.sourceSha256}`;
  if (sha256(input.source) !== input.sourceSha256) {
    return Result.err(new WorkflowArtifactInvalidId({ message: "Workflow source hash mismatch" }));
  }
  const bytes = new TextEncoder().encode(input.source);
  if (bytes.byteLength > input.maxBytes) {
    return Result.err(
      new WorkflowArtifactValueTooLarge({
        artifactId,
        maxBytes: input.maxBytes,
        message: `Workflow source exceeds ${input.maxBytes} bytes`,
      }),
    );
  }
  return publishArtifact({
    blobStore: input.blobStore,
    workflowStore: input.workflowStore,
    artifactId,
    bytes,
    createdAt: (input.now ?? Date.now)(),
    verify: async (reference) =>
      (
        await readWorkflowSourceArtifact({
          blobStore: input.blobStore,
          reference,
          maxBytes: input.maxBytes,
        })
      ).map(() => undefined),
  });
}

export async function readWorkflowSourceArtifact(input: {
  readonly blobStore: BlobStore;
  readonly reference: WorkflowArtifactReference;
  readonly maxBytes: number;
}): Promise<ResultType<string, WorkflowArtifactReadError>> {
  const expectedHash = artifactHash(input.reference.artifactId, WORKFLOW_SOURCE_ARTIFACT_PREFIX);
  return expectedHash.andThenAsync(async function readSource(hash) {
    const bytes = await readArtifactBytes(input);
    return bytes.andThen((content) => {
      const source = new TextDecoder().decode(content);
      return sha256(source) === hash
        ? Result.ok(source)
        : Result.err(
            new WorkflowArtifactIoFailed({
              artifactId: input.reference.artifactId,
              operation: "read-artifact",
              code: "WORKFLOW_HASH_MISMATCH",
              message: "Workflow source artifact hash does not match its identity",
            }),
          );
    });
  });
}

export async function deleteWorkflowArtifactIfUnreferenced(input: {
  readonly blobStore: BlobStore;
  readonly workflowStore: DurableWorkflowStore;
  readonly artifactId: string;
}): Promise<ResultType<"deleted" | "retained" | "absent", WorkflowArtifactIoFailed>> {
  const released = input.workflowStore
    .releaseWorkflowArtifactIfUnreferenced(input.artifactId)
    .mapError((error) => ioFailure(input.artifactId, "lookup-artifact", error));
  const releaseOutcome = released.match<
    | { readonly kind: "released"; readonly reference: WorkflowArtifactReference }
    | { readonly kind: "retained" }
    | { readonly kind: "error"; readonly error: WorkflowArtifactIoFailed }
  >({
    ok: (reference) =>
      reference === null ? { kind: "retained" } : { kind: "released", reference },
    err: (error) => ({ kind: "error", error }),
  });
  if (releaseOutcome.kind === "error") return Result.err(releaseOutcome.error);
  if (releaseOutcome.kind === "retained") return Result.ok("retained");
  return (await input.blobStore.delete(releaseOutcome.reference.blobRef))
    .map((status) => (status === "absent" ? "absent" : "deleted"))
    .mapError((error) => ioFailure(input.artifactId, "delete-artifact", error));
}
