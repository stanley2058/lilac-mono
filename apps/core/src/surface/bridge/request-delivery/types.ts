import type { BlobHandleV1, BlobRefV1, BlobResolveError } from "@stanley2058/lilac-blob-storage";
import { TaggedError, type Result } from "better-result";

export const REQUEST_DELIVERY_RESOLVE_TIMEOUT_MS = 60_000 as const;

/**
 * GitHub lets users redeliver a webhook delivery for 3 days after it was sent. Keeping receipts for
 * 7 days covers that window with margin for clock skew and late maintenance, while bounding the
 * table to one week of published request IDs.
 */
export const REQUEST_DELIVERY_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RequestDeliveryInputTarget =
  | { readonly kind: "handle"; readonly blob: BlobHandleV1 }
  | { readonly kind: "reference"; readonly blob: BlobRefV1 };

export type RequestDeliveryTerminalKind =
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned"
  | "publication-failed"
  | "upload-failed"
  | "upload-timeout";

export type RequestDeliveryTerminalOutcome = {
  readonly kind: RequestDeliveryTerminalKind;
  readonly code?: string;
};

export type RequestDeliveryPublication = {
  readonly streamId: string;
  readonly recordedAt: number;
};

export type PreparedRequestDelivery<TEnvelope> = {
  readonly state: "prepared";
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly envelope: TEnvelope;
  readonly inputHandles: readonly BlobHandleV1[];
  readonly publication?: RequestDeliveryPublication;
  readonly createdAt: number;
  readonly transportCommittedAt?: number;
};

export type AcceptedRequestDelivery<TWork> = {
  readonly state: "accepted";
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly work: TWork;
  readonly inputReferences: readonly BlobRefV1[];
  readonly publication?: RequestDeliveryPublication;
  readonly createdAt: number;
  readonly acceptedAt: number;
  readonly transportCommittedAt?: number;
};

export type TerminalRequestDelivery = {
  readonly state: "terminal";
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly outcome: RequestDeliveryTerminalOutcome;
  readonly publication?: RequestDeliveryPublication;
  readonly createdAt: number;
  readonly acceptedAt?: number;
  readonly terminalAt: number;
  readonly transportCommitRequired: boolean;
  readonly transportCommittedAt?: number;
  readonly inputCleanupPending: readonly RequestDeliveryInputTarget[];
  readonly finalReplayDeadline?: number;
};

export type RequestDeliveryRecord<TEnvelope, TWork> =
  | PreparedRequestDelivery<TEnvelope>
  | AcceptedRequestDelivery<TWork>
  | TerminalRequestDelivery;

export type RequestOutputLifecycle<TMetadata> = {
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly target: RequestDeliveryInputTarget;
  readonly metadata: TMetadata;
  readonly createdAt: number;
  readonly deleteAfter?: number;
};

export type RequestDeliverySerializedValue =
  | null
  | boolean
  | number
  | string
  | readonly RequestDeliverySerializedValue[]
  | { readonly [key: string]: RequestDeliverySerializedValue };

export interface RequestDeliveryValueCodec<T> {
  decode(value: T | RequestDeliverySerializedValue): Result<T, Error>;
  serialize?(value: T): Result<string, Error>;
  deserialize?(value: string): Result<T, Error>;
}

export class RequestDeliverySqliteFailure extends TaggedError("RequestDeliverySqliteFailure")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

export class RequestDeliveryCodecFailure extends TaggedError("RequestDeliveryCodecFailure")<{
  readonly field: string;
  readonly message: string;
}> {}

export class RequestDeliveryConflict extends TaggedError("RequestDeliveryConflict")<{
  readonly requestDeliveryId: string;
  readonly message: string;
}> {}

export class RequestDeliveryNotFound extends TaggedError("RequestDeliveryNotFound")<{
  readonly requestDeliveryId: string;
  readonly message: string;
}> {}

export class RequestDeliveryInvalidTransition extends TaggedError(
  "RequestDeliveryInvalidTransition",
)<{
  readonly requestDeliveryId: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
}> {}

export class RequestDeliveryResolutionFailed extends TaggedError(
  "RequestDeliveryResolutionFailed",
)<{
  readonly requestDeliveryId: string;
  readonly objectId: string;
  readonly resolutionError: BlobResolveError;
  readonly message: string;
}> {}

export class RequestDeliveryAdmissionRejected extends TaggedError(
  "RequestDeliveryAdmissionRejected",
)<{
  readonly requestDeliveryId: string;
  readonly disposition: "park" | "terminal";
  readonly code: string;
  readonly message: string;
}> {}

export class RequestDeliveryDeleteFailed extends TaggedError("RequestDeliveryDeleteFailed")<{
  readonly requestDeliveryId: string;
  readonly objectId: string;
  readonly message: string;
}> {}

export class RequestDeliveryPreparationCleanupFailed extends TaggedError(
  "RequestDeliveryPreparationCleanupFailed",
)<{
  readonly requestDeliveryId: string;
  readonly prepareError: RequestDeliveryStoreError;
  readonly cleanupFailures: readonly RequestDeliveryDeleteFailed[];
  readonly message: string;
}> {}

export type RequestDeliveryStoreError =
  | RequestDeliverySqliteFailure
  | RequestDeliveryCodecFailure
  | RequestDeliveryConflict
  | RequestDeliveryNotFound
  | RequestDeliveryInvalidTransition
  | RequestDeliveryPreparationCleanupFailed;

export type RequestDeliveryPrepareResult<TEnvelope> = {
  readonly status: "created" | "existing";
  readonly record: PreparedRequestDelivery<TEnvelope>;
};

export type RequestDeliveryAcceptanceResult<TWork> = {
  readonly status: "accepted" | "already-accepted";
  readonly record: AcceptedRequestDelivery<TWork>;
};

export type RequestDeliveryTerminalizeResult = {
  readonly status: "terminalized" | "already-terminal";
  readonly record: TerminalRequestDelivery;
};

export type RequestDeliveryHandleOutcome<TWork> =
  | {
      readonly disposition: "commit";
      readonly reason: "already-accepted" | "already-terminal" | "terminalized";
    }
  | {
      readonly disposition: "accepted";
      readonly record: AcceptedRequestDelivery<TWork>;
      readonly source: "new";
    }
  | {
      readonly disposition: "park";
      readonly error: RequestDeliveryStoreError | RequestDeliveryAdmissionRejected;
    };

export type RequestPublicationFailure = {
  readonly certainty: "known" | "ambiguous";
  readonly code: string;
};

export type RequestPublicationReceipt = {
  readonly streamId: string;
};

export type RequestPublicationClaim = {
  readonly requestDeliveryId: string;
  readonly token: string;
};

export type RequestPublicationClaimOutcome =
  | { readonly status: "acquired"; readonly claim: RequestPublicationClaim }
  | { readonly status: "contended" };

export type RequestPublicationConfirmationOutcome = "absent" | "confirmed" | "fenced" | "mismatch";

export type RequestPublicationAbandonOutcome = "abandoned" | "absent" | "fenced" | "marker-present";

export class RequestDeliveryPublicationFenceRejected extends TaggedError(
  "RequestDeliveryPublicationFenceRejected",
)<{
  readonly requestDeliveryId: string;
  readonly stage: "claim" | "confirmation";
  readonly outcome: string;
  readonly message: string;
}> {}

export type PrepareAndPublishOutcome<TEnvelope, TWork> = {
  readonly status: "published" | "already-published" | "ambiguous" | "terminalized";
  readonly record: RequestDeliveryRecord<TEnvelope, TWork>;
  readonly publicationError?: Error;
};

export interface RequestDeliveryPublisher<TEnvelope> {
  acquire(input: {
    readonly requestDeliveryId: string;
  }): Promise<Result<RequestPublicationClaimOutcome, Error>>;

  publish(input: {
    readonly requestDeliveryId: string;
    readonly envelope: TEnvelope;
    readonly claim: RequestPublicationClaim;
  }): Promise<Result<RequestPublicationReceipt, Error>>;

  classifyFailure(error: Error): RequestPublicationFailure;

  confirm(input: {
    readonly claim: RequestPublicationClaim;
    readonly streamId: string;
  }): Promise<Result<RequestPublicationConfirmationOutcome, Error>>;

  abandon(input: {
    readonly claim: RequestPublicationClaim;
  }): Promise<Result<RequestPublicationAbandonOutcome, Error>>;
}

export type RequestAdmissionDecision = {
  readonly disposition: "park" | "terminal";
  readonly code: string;
};

export interface RequestDeliveryAdmission<TEnvelope, TWork> {
  validateAndBuildWork(input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly envelope: TEnvelope;
    readonly inputReferences: readonly BlobRefV1[];
  }): Promise<Result<TWork, RequestDeliveryAdmissionRejected>>;
}

export type RequestDeliveryMaintenanceSummary = {
  readonly inputObjectsDeleted: number;
  readonly outputObjectsDeleted: number;
  readonly tombstonesDeleted: number;
  readonly receiptsDeleted: number;
  readonly failures: readonly RequestDeliveryDeleteFailed[];
};

export type RequestDeliveryAdmissionError = RequestDeliveryAdmissionRejected;

export interface RequestOutputLifecycleRegistrar<TMetadata> {
  registerOutputHandle(input: {
    readonly requestDeliveryId: string;
    readonly handle: BlobHandleV1;
    readonly metadata: TMetadata;
  }): Result<RequestOutputLifecycle<TMetadata>, RequestDeliveryStoreError>;
}
