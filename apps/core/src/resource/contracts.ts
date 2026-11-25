import { randomBytes as nodeRandomBytes } from "node:crypto";

import { blobRefV1Schema, type BlobRefV1 } from "@stanley2058/lilac-blob-storage";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import { ResourceInvalidUri } from "./errors";

export const RESOURCE_MAX_BYTES = 512 * 1024 * 1024;
export const RESOURCE_MODEL_INLINE_MAX_BYTES = 25 * 1024 * 1024;
export const RESOURCE_MATERIALIZE_CALL_MAX_BYTES = 1024 * 1024 * 1024;
export const RESOURCE_MATERIALIZE_MAX_COUNT = 32;

export type ResourceLimits = {
  readonly maxBytes: number;
  readonly modelInlineMaxBytes: number;
  readonly materializeCallMaxBytes: number;
  readonly materializeMaxCount: number;
  readonly sniffBytes: number;
};

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxBytes: RESOURCE_MAX_BYTES,
  modelInlineMaxBytes: RESOURCE_MODEL_INLINE_MAX_BYTES,
  materializeCallMaxBytes: RESOURCE_MATERIALIZE_CALL_MAX_BYTES,
  materializeMaxCount: RESOURCE_MATERIALIZE_MAX_COUNT,
  sniffBytes: 64 * 1024,
};

const resourceIdPattern = /^r1_[0-9a-f]{32}$/u;
const resourceUriPattern = /^resource:\/\/(r1_[0-9a-f]{32})$/u;
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative();
const normalizedMediaTypeSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim().toLowerCase() && !value.includes(";"), {
    message: "Media type must be normalized lowercase without parameters",
  });

export const resourceIdSchema = z.string().regex(resourceIdPattern);
export type ResourceId = z.infer<typeof resourceIdSchema>;

export const resourceUriSchema = z.string().regex(resourceUriPattern);
export type ResourceUri = z.infer<typeof resourceUriSchema>;

export const discordResourceOriginV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("discord-attachment"),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  ordinal: nonNegativeSafeIntegerSchema,
  attachmentId: z.string().min(1).optional(),
});
export type DiscordResourceOriginV1 = z.infer<typeof discordResourceOriginV1Schema>;

export const nativeResourceOriginV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("native-upload"),
  threadId: z.string().min(1),
  uploadId: z.string().min(1),
  uploaderId: z.string().min(1),
});
export type NativeResourceOriginV1 = z.infer<typeof nativeResourceOriginV1Schema>;

export const resourceOriginV1Schema = z.discriminatedUnion("kind", [
  discordResourceOriginV1Schema,
  nativeResourceOriginV1Schema,
]);
export type ResourceOriginV1 = z.infer<typeof resourceOriginV1Schema>;

export const resourceCacheV1Schema = z.strictObject({
  blob: blobRefV1Schema,
  cachedAt: nonNegativeSafeIntegerSchema,
});
export type ResourceCacheV1 = z.infer<typeof resourceCacheV1Schema>;

export const RESOURCE_IMAGE_INLINE_MAX_BYTES = 1024 * 1024;
// Gemini rejects inline audio and video above 20 MB.
export const RESOURCE_MEDIA_INLINE_MAX_BYTES = 20 * 1000 * 1000;

export const resourceImagePreviewSchema = z.strictObject({
  policyVersion: z.literal(1),
  sourceSha256: blobRefV1Schema.shape.sha256,
  blob: blobRefV1Schema.extend({ expiresAt: z.number().int().nonnegative() }),
  mediaType: z.enum(["image/png", "image/jpeg"]),
  originalWidth: z.number().int().positive(),
  originalHeight: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ResourceImagePreview = z.infer<typeof resourceImagePreviewSchema>;

export const resourceRecordV1Schema = z.strictObject({
  version: z.literal(1),
  resourceId: resourceIdSchema,
  origin: resourceOriginV1Schema,
  filename: z.string().min(1).optional(),
  declaredMediaType: normalizedMediaTypeSchema.optional(),
  detectedMediaType: normalizedMediaTypeSchema.optional(),
  reportedByteLength: nonNegativeSafeIntegerSchema.optional(),
  createdAt: nonNegativeSafeIntegerSchema,
  cache: resourceCacheV1Schema.optional(),
  imagePreview: resourceImagePreviewSchema.optional(),
});
export type ResourceRecordV1 = z.infer<typeof resourceRecordV1Schema>;

export type RegisterResourceInput = {
  readonly origin: ResourceOriginV1;
  readonly filename?: string;
  readonly declaredMediaType?: string;
  readonly reportedByteLength?: number;
};

export type ResourceDescriptor = {
  readonly uri: ResourceUri;
  readonly filename?: string;
  readonly declaredMediaType?: string;
  readonly detectedMediaType?: string;
  readonly reportedByteLength?: number;
  readonly cachedByteLength?: number;
};

export type MaterializedResource = {
  readonly uri: string;
  readonly path: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly bytes: number;
  readonly sha256: string;
};

export function parseResourceUri(input: string): ResultType<ResourceId, ResourceInvalidUri> {
  const match = resourceUriPattern.exec(input);
  return match?.[1]
    ? Result.ok(match[1])
    : Result.err(
        new ResourceInvalidUri({
          uri: input,
          message: "Resource URI must use the exact resource://r1_<128-bit-id> format",
        }),
      );
}

export function formatResourceUri(resourceId: ResourceId): ResourceUri {
  return `resource://${resourceId}`;
}

export function createResourceId(
  randomBytes: (length: number) => Uint8Array = nodeRandomBytes,
): ResourceId {
  return `r1_${Buffer.from(randomBytes(16)).toString("hex")}`;
}

export function resourceDescriptorFromRecord(record: ResourceRecordV1): ResourceDescriptor {
  return {
    uri: formatResourceUri(record.resourceId),
    ...(record.filename === undefined ? {} : { filename: record.filename }),
    ...(record.declaredMediaType === undefined
      ? {}
      : { declaredMediaType: record.declaredMediaType }),
    ...(record.detectedMediaType === undefined
      ? {}
      : { detectedMediaType: record.detectedMediaType }),
    ...(record.reportedByteLength === undefined
      ? {}
      : { reportedByteLength: record.reportedByteLength }),
    ...(record.cache === undefined ? {} : { cachedByteLength: record.cache.blob.byteLength }),
  };
}

export type ResourceReadComplete = {
  readonly sha256: string;
  readonly byteLength: number;
};

export type ResourceBlobReference = BlobRefV1;
