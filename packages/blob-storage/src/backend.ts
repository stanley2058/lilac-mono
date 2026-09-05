import { Panic, Result, type Result as ResultType } from "better-result";

import { BlobAdapterFailure, type BlobAdapterFailureKind } from "./errors";

export const LAYOUT_MARKER = '{"version":1,"name":"lilac-blob-storage"}\n';

export type BlobBackendKind = "local" | "s3" | "memory";

export type BlobSink = {
  write(chunk: Uint8Array): Promise<ResultType<void, BlobAdapterFailure>>;
  finish(): Promise<ResultType<void, BlobAdapterFailure>>;
  abort(): Promise<ResultType<void, BlobAdapterFailure>>;
};

export type BlobBackend = {
  readonly kind: BlobBackendKind;
  initialize(input: {
    readonly createIfMissing: boolean;
  }): Promise<ResultType<void, BlobAdapterFailure>>;
  createReservation(
    objectId: string,
    serialized: string,
    expiresAt?: number,
  ): Promise<ResultType<void, BlobAdapterFailure>>;
  // Removing the base reservation makes every overlay inert. Delayed CAS writers can
  // outlive deletion and must remove their new overlay when they observe no base.
  readReservation(objectId: string): Promise<ResultType<string | null, BlobAdapterFailure>>;
  compareAndSwapReservation(
    objectId: string,
    expectedSerialized: string,
    serialized: string,
  ): Promise<ResultType<boolean, BlobAdapterFailure>>;
  openSink(objectId: string, generation: string): Promise<ResultType<BlobSink, BlobAdapterFailure>>;
  commitTemp(
    objectId: string,
    generation: string,
    contentKey: string,
    metadata: string,
    expected: { readonly sha256: string; readonly byteLength: number },
  ): Promise<ResultType<void, BlobAdapterFailure>>;
  openContent(
    contentKey: string,
  ): Promise<ResultType<ReadableStream<Uint8Array> | null, BlobAdapterFailure>>;
  readMetadata(contentKey: string): Promise<ResultType<string | null, BlobAdapterFailure>>;
  deleteKeys(keys: readonly string[]): Promise<ResultType<number, BlobAdapterFailure>>;
  // Pages advance past retained expiry entries and wrap after each complete scan,
  // so an interrupted producer cannot starve later objects of maintenance.
  listExpiredReservationIds(
    now: number,
    limit: number,
  ): Promise<
    ResultType<{ readonly ids: readonly string[]; readonly remaining: boolean }, BlobAdapterFailure>
  >;
};

export type ClassifiedAdapterCause =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "opaque" };

export type AdapterErrorDetails = {
  readonly code: string;
  readonly status?: number;
};

export function classifyAdapterErrorDetails(error: Error): AdapterErrorDetails {
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  let status: number | undefined;
  if ("status" in error && typeof error.status === "number") {
    status = error.status;
  } else if ("statusCode" in error && typeof error.statusCode === "number") {
    status = error.statusCode;
  }
  return { code, status };
}

function failureKind(error: Error | null): BlobAdapterFailureKind {
  if (error !== null) {
    const { code, status } = classifyAdapterErrorDetails(error);
    const text = `${error.name} ${code} ${error.message}`.toLowerCase();
    if (
      text.includes("credential") ||
      text.includes("signature") ||
      text.includes("invalidaccesskeyid") ||
      text.includes("expiredtoken") ||
      status === 401
    )
      return "authentication";
    if (
      text.includes("forbidden") ||
      text.includes("access denied") ||
      text.includes("403") ||
      text.includes("accessdenied") ||
      status === 403
    ) {
      return "authorization";
    }
    if (
      text.includes("throttl") ||
      text.includes("slowdown") ||
      text.includes("429") ||
      status === 429
    ) {
      return "throttled";
    }
    if (text.includes("timeout") || text.includes("timed out")) return "timeout";
    if (text.includes("unavailable") || text.includes("connection") || text.includes("network")) {
      return "unavailable";
    }
  }
  return "io";
}

export function classifyAdapterCause(cause: unknown): ClassifiedAdapterCause {
  if (Panic.is(cause)) return { kind: "panic", panic: cause };
  if (cause instanceof Error) return { kind: "error", error: cause };
  return { kind: "opaque" };
}

export function classifyBlobDefect(cause: unknown): Panic {
  return Panic.is(cause) ? cause : new Panic({ message: "Unexpected blob storage defect", cause });
}

export async function captureAdapterOperation<T>(input: {
  readonly adapter: BlobBackendKind;
  readonly operation: string;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, BlobAdapterFailure>> {
  const captured = await Result.tryPromise<T, ClassifiedAdapterCause>({
    try: input.run,
    catch: classifyAdapterCause,
  });
  return captured.match<() => ResultType<T, BlobAdapterFailure>>({
    ok: (value) => () => Result.ok(value),
    err: (failure) => () => {
      if (failure.kind === "panic") signalRetainedBlobPanic(failure.panic);
      return Result.err(
        new BlobAdapterFailure({
          adapter: input.adapter,
          kind: failureKind(failure.kind === "error" ? failure.error : null),
          operation: input.operation,
          message: `${input.adapter} blob storage failed to ${input.operation}`,
        }),
      );
    },
  })();
}

/** Exact adapter signal captured immediately by captureAdapterOperation. */
export function signalBlobAdapterFailure(message: string): never {
  throw new Error(message);
}

/** Exact defect-preservation signal used only after an external Result capture. */
export function signalRetainedBlobPanic(cause: Panic): never;
export function signalRetainedBlobPanic(cause: unknown): void;
export function signalRetainedBlobPanic(cause: unknown): void {
  if (Panic.is(cause)) throw cause;
}

/** Exact unexpected-defect signal retained for the reviewed architecture seam. */
export function signalBlobDefect(panic: Panic): never {
  throw panic;
}

export function reservationKey(objectId: string): string {
  return `reservations/${objectId}.json`;
}

export function reservationTransitionKey(objectId: string): string {
  return `reservations/${objectId}.transition.json`;
}

export function reservationDecisionKey(objectId: string): string {
  return `reservations/${objectId}.decision.json`;
}

export function reservationUpdateKey(objectId: string, expectedSerialized: string): string {
  if (expectedSerialized.includes('"state":"pending"')) return reservationTransitionKey(objectId);
  if (expectedSerialized.includes('"state":"staged"')) return reservationDecisionKey(objectId);
  return reservationFenceKey(objectId);
}

export function reservationFenceKey(objectId: string): string {
  return `reservations/${objectId}.fence.json`;
}

export function temporaryKey(objectId: string, generation: string): string {
  return `temporary/${objectId}.${generation}`;
}

export function contentKeyFor(input: {
  readonly objectId: string;
  readonly expiresAt?: number;
}): string {
  if (input.expiresAt === undefined) return `content/durable/${input.objectId}`;
  const partition = new Date(input.expiresAt).toISOString().slice(0, 10);
  return `content/expires/${partition}/${input.objectId}`;
}

export function metadataKey(contentKey: string): string {
  return `${contentKey}.json`;
}

export function expiryIndexKey(expiresAt: number, objectId: string): string {
  return `expiry/${expiresAt.toString().padStart(16, "0")}/${objectId}`;
}
