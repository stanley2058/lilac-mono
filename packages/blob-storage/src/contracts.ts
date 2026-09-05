import type { Result } from "better-result";
import { z } from "zod";

import type {
  BlobCloseError,
  BlobDeleteError,
  BlobMaintenanceError,
  BlobReadError,
  BlobReadTerminalError,
  BlobResolveError,
  BlobUploadStartError,
  BlobWriteError,
} from "./errors";

const objectIdSchema = z.string().regex(/^b1_[0-9a-f]{32}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const byteLengthSchema = z.number().int().nonnegative().safe();
const expiresAtSchema = z.number().int().nonnegative().safe().max(8_640_000_000_000_000);

export const blobHandleV1Schema = z.strictObject({
  version: z.literal(1),
  objectId: objectIdSchema,
});

export const blobRefV1Schema = z.strictObject({
  version: z.literal(1),
  objectId: objectIdSchema,
  sha256: sha256Schema,
  byteLength: byteLengthSchema,
  expiresAt: expiresAtSchema.optional(),
});

export type BlobHandleV1 = z.infer<typeof blobHandleV1Schema>;
export type BlobRefV1 = z.infer<typeof blobRefV1Schema>;

export type BlobRetention =
  | { readonly kind: "durable" }
  | { readonly kind: "expires"; readonly expiresAt: number };

export type BlobSource = Uint8Array | ReadableStream<Uint8Array>;

export type BlobLifecycleLogContext = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export type BlobLifecycleLogger = {
  debug(message: string, context: BlobLifecycleLogContext): void;
  error(message: string, context: BlobLifecycleLogContext): void;
};

export type BlobReadComplete = {
  readonly sha256: string;
  readonly byteLength: number;
};

export type BlobRead = {
  readonly ref: BlobRefV1;
  readonly stream: ReadableStream<Uint8Array>;
  readonly completion: Promise<Result<BlobReadComplete, BlobReadTerminalError>>;
};

export type BlobUpload = {
  readonly handle: BlobHandleV1;
  readonly completion: Promise<Result<BlobRefV1, BlobWriteError>>;
};

export type BlobMaintenanceSummary = {
  readonly inspected: number;
  readonly deleted: number;
  readonly remaining: boolean;
};

export type BlobCloseSummary = {
  readonly completedUploads: number;
  readonly interruptedUploads: number;
};

export type BlobStore = {
  startStagedUpload(input: {
    readonly source: BlobSource;
    readonly stagingExpiresAt: number;
    readonly expectedSha256?: string;
    readonly expectedByteLength?: number;
  }): Promise<Result<BlobUpload, BlobUploadStartError>>;

  adopt(handle: BlobHandleV1): Promise<Result<BlobRefV1, BlobResolveError>>;

  startUpload(input: {
    readonly source: BlobSource;
    readonly retention: BlobRetention;
    readonly expectedSha256?: string;
    readonly expectedByteLength?: number;
  }): Promise<Result<BlobUpload, BlobUploadStartError>>;

  resolve(
    handle: BlobHandleV1,
    options: { readonly timeoutMs: number },
  ): Promise<Result<BlobRefV1, BlobResolveError>>;

  open(ref: BlobRefV1): Promise<Result<BlobRead, BlobReadError>>;

  delete(target: BlobHandleV1 | BlobRefV1): Promise<Result<"deleted" | "absent", BlobDeleteError>>;

  maintain(input?: {
    readonly now?: number;
    readonly limit?: number;
  }): Promise<Result<BlobMaintenanceSummary, BlobMaintenanceError>>;

  close(input: {
    readonly deadlineAtMs: number;
  }): Promise<Result<BlobCloseSummary, BlobCloseError>>;
};
