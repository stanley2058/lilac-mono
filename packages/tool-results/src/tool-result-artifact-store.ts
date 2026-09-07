import type { Readable } from "node:stream";
import { TaggedError, type Result as ResultType } from "better-result";

import type {
  ToolResultArtifactMetadataCodecError,
  ToolResultArtifactMetadataIssueCode,
} from "./tool-result-artifact-metadata-codec";

export const TOOL_RESULT_URI_PREFIX = "tool-result://";
export const TOOL_RESULT_UNAVAILABLE_MESSAGE =
  "This transient tool result is no longer available because it expired or was evicted. Re-run the original tool call if the output is still needed.";
export { TOOL_RESULT_MAX_PAGE_CHARACTERS } from "./tool-result-window";

export type ToolResultArtifactStart =
  | { type: "offset"; offset: number }
  | { type: "line"; line: number; column?: number };

type ToolResultArtifactScope = { scopeId: string } | { sessionId: string };

type ToolResultArtifactScopeLimit = { maxBytesPerScope: number } | { maxBytesPerSession: number };

export type CreateToolResultArtifactBaseParams = ToolResultArtifactScope &
  ToolResultArtifactScopeLimit & {
    requestId: string;
    toolCallId: string;
    toolName: string;
    ttlMs: number;
    maxArtifactBytes?: number;
  };

export type CreateToolResultArtifactParams = CreateToolResultArtifactBaseParams & {
  content: string;
};

export type CreateToolResultArtifactFileParams = CreateToolResultArtifactBaseParams & {
  sourcePath: string;
};

export type CreateToolResultArtifactStreamParams = CreateToolResultArtifactBaseParams & {
  source: Readable;
};

export type CreatedToolResultArtifact = {
  id: string;
  uri: string;
  bytes: number;
  scopeBytes: number;
  /** @deprecated Use scopeBytes. */
  sessionBytes: number;
  evicted: number;
  oversized: boolean;
};

export class ToolResultArtifactTooLargeError extends TaggedError(
  "ToolResultArtifactTooLargeError",
)<{
  readonly maxArtifactBytes: number;
  readonly message: string;
}> {}

export class ToolResultArtifactStorageFailure extends TaggedError(
  "ToolResultArtifactStorageFailure",
)<{
  readonly operation: ToolResultArtifactStorageOperation;
  readonly code: string;
  readonly message: string;
}> {}

export class ToolResultArtifactInvalidInput extends TaggedError("ToolResultArtifactInvalidInput")<{
  readonly message: string;
}> {}

export class ToolResultArtifactDecryptAuthenticationFailed extends TaggedError(
  "ToolResultArtifactDecryptAuthenticationFailed",
)<{
  readonly target: "metadata" | "content";
  readonly issueCode: "decrypt-auth-failed";
  readonly message: string;
}> {}

export class ToolResultArtifactContentMismatch extends TaggedError(
  "ToolResultArtifactContentMismatch",
)<{
  readonly issueCode: "content-mismatch";
  readonly message: string;
}> {}

export class ToolResultArtifactUnavailable extends TaggedError("ToolResultArtifactUnavailable")<{
  readonly reason: "invalid-uri" | "absent" | "scope-mismatch" | "expired-or-evicted";
  readonly message: string;
}> {}

export class ToolResultArtifactReadTooLarge extends TaggedError("ToolResultArtifactReadTooLarge")<{
  readonly maxBytes: number;
  readonly actualBytes: number;
  readonly message: string;
}> {}

export class ToolResultArtifactReadCancelled extends TaggedError(
  "ToolResultArtifactReadCancelled",
)<{
  readonly message: string;
}> {}

export class ToolResultArtifactMaintenanceAndCleanupFailure extends TaggedError(
  "ToolResultArtifactMaintenanceAndCleanupFailure",
)<{
  readonly primaryError: ToolResultArtifactReadError;
  readonly cleanupError: ToolResultArtifactStorageFailure;
  readonly message: string;
}> {}

export class ToolResultArtifactWriteAndCleanupFailure extends TaggedError(
  "ToolResultArtifactWriteAndCleanupFailure",
)<{
  readonly primaryError: ToolResultArtifactWriteOperationError;
  readonly cleanupErrors: readonly ToolResultArtifactStorageFailure[];
  readonly message: string;
}> {}

type ToolResultArtifactStorageOperation =
  | "initialize"
  | "list-metadata"
  | "read-metadata"
  | "read-content"
  | "write-content"
  | "write-metadata"
  | "remove-artifact"
  | "maintenance";

export type ToolResultArtifactDiagnostic = {
  readonly operation: "read-metadata" | "read-content";
  readonly issueCode:
    | ToolResultArtifactMetadataIssueCode
    | "decrypt-auth-failed"
    | "content-mismatch";
  readonly version?: number;
};

export type ToolResultArtifactStoreOptions = {
  readonly onDiagnostic?: (diagnostic: ToolResultArtifactDiagnostic) => void;
};

export type ToolResultArtifactMetadataReadError =
  | ToolResultArtifactMetadataCodecError
  | ToolResultArtifactDecryptAuthenticationFailed
  | ToolResultArtifactStorageFailure;

export type ToolResultArtifactWriteOperationError =
  | ToolResultArtifactMetadataReadError
  | ToolResultArtifactContentMismatch
  | ToolResultArtifactInvalidInput
  | ToolResultArtifactTooLargeError;

export type ToolResultArtifactWriteError =
  | ToolResultArtifactWriteOperationError
  | ToolResultArtifactWriteAndCleanupFailure;

export type ToolResultArtifactReadOperationError =
  | ToolResultArtifactMetadataReadError
  | ToolResultArtifactContentMismatch
  | ToolResultArtifactReadTooLarge
  | ToolResultArtifactReadCancelled
  | ToolResultArtifactUnavailable;

export type ToolResultArtifactReadError = ToolResultArtifactReadOperationError;

export type ToolResultArtifactError = ToolResultArtifactWriteError | ToolResultArtifactReadError;

export type ToolResultArtifactMaintenanceError =
  | ToolResultArtifactReadError
  | ToolResultArtifactStorageFailure
  | ToolResultArtifactMaintenanceAndCleanupFailure;

export type ToolResultArtifactMaintenanceResult = {
  readonly removedInvalid: number;
  readonly removedExpired: number;
};

export type ToolResultArtifactRead = {
  readonly content: string;
  readonly id: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export type ToolResultArtifactReadWindow = ToolResultArtifactRead & {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly totalCharacters: number;
  readonly hasMore: boolean;
  readonly nextStart?: ToolResultArtifactStart;
};

export type ToolResultArtifactReadOptions = {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
};

export type ToolResultArtifactAvailability<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false };

export type ToolResultArtifactReadMaintenancePolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "maintain-after-unavailable";
      readonly onMaintenanceError: "reject" | "unavailable";
    };

export type ToolResultArtifactStore = {
  readonly rootDir: string;
  init(): Promise<ResultType<void, ToolResultArtifactError>>;
  create(
    params: CreateToolResultArtifactParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  createFromFile(
    params: CreateToolResultArtifactFileParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  createFromStream(
    params: CreateToolResultArtifactStreamParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  read(
    uri: string,
    scopeId: string,
    options?: ToolResultArtifactReadOptions,
  ): Promise<ResultType<ToolResultArtifactRead, ToolResultArtifactError>>;
  readWindow(
    uri: string,
    scopeId: string,
    options: {
      start: ToolResultArtifactStart;
      maxCharacters: number;
      maxLines: number;
      /** Maximum payload bytes. Must be at least 4 when set. */
      maxOutputBytes?: number;
    },
  ): Promise<ResultType<ToolResultArtifactReadWindow, ToolResultArtifactError>>;
  maintain(
    now?: number,
  ): Promise<ResultType<ToolResultArtifactMaintenanceResult, ToolResultArtifactMaintenanceError>>;
};

export function adaptToolResultArtifactReadToAvailability<T extends object>(
  result: ResultType<T, ToolResultArtifactError>,
): ToolResultArtifactAvailability<T> {
  const outcome = result.match<
    | { type: "available"; value: T }
    | { type: "unavailable" }
    | { type: "invalid"; error: ToolResultArtifactInvalidInput }
  >({
    ok: (value) => ({ type: "available", value }),
    err: (error) =>
      error instanceof ToolResultArtifactInvalidInput
        ? { type: "invalid", error }
        : { type: "unavailable" },
  });
  if (outcome.type === "invalid") {
    throw new RangeError(outcome.error.message);
  }
  return outcome.type === "available" ? { ok: true, ...outcome.value } : { ok: false };
}

export async function adaptToolResultArtifactReadToUnavailablePolicy<T extends object>(
  store: ToolResultArtifactStore,
  result: ResultType<T, ToolResultArtifactError>,
  policy: ToolResultArtifactReadMaintenancePolicy = {
    kind: "maintain-after-unavailable",
    onMaintenanceError: "unavailable",
  },
): Promise<ToolResultArtifactAvailability<T>> {
  const unavailable = result.match({
    ok: () => false,
    err: (error) =>
      !(
        error instanceof ToolResultArtifactInvalidInput ||
        error instanceof ToolResultArtifactReadTooLarge ||
        error instanceof ToolResultArtifactReadCancelled
      ),
  });
  if (unavailable && policy.kind === "maintain-after-unavailable") {
    const maintained = await store.maintain();
    const maintenanceError = maintained.match({ ok: () => null, err: (error) => error });
    if (maintenanceError && policy.onMaintenanceError === "reject") {
      throw maintenanceError;
    }
  }
  return adaptToolResultArtifactReadToAvailability(result);
}

export function adaptToolResultArtifactStoreInitToHost(
  result: ResultType<void, ToolResultArtifactError>,
): void {
  const error = result.match({ ok: () => null, err: (failure) => failure });
  if (error) throw new Error(error.message);
}
