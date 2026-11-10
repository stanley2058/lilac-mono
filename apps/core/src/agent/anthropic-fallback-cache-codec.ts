import { Result, TaggedError, type Result as ResultType } from "better-result";
import { blobRefV1Schema, type BlobRefV1 } from "@stanley2058/lilac-blob-storage";

export const ANTHROPIC_FALLBACK_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

export type AnthropicFallbackCacheRecord =
  | {
      readonly version: 1;
      readonly status: "ok";
      readonly mediaType?: string;
      readonly byteLength: number;
      readonly cachedAt: number;
      readonly blob: BlobRefV1;
    }
  | {
      readonly version: 1;
      readonly status: "oversize-image";
      readonly mediaType?: string;
      readonly byteLength: number;
      readonly cachedAt: number;
    };

export class AnthropicFallbackCacheMalformedSerialization extends TaggedError(
  "AnthropicFallbackCacheMalformedSerialization",
)<{
  readonly message: string;
}> {}

export class AnthropicFallbackCacheUnsupportedVersion extends TaggedError(
  "AnthropicFallbackCacheUnsupportedVersion",
)<{
  readonly message: string;
}> {}

export class AnthropicFallbackCacheCorruptFields extends TaggedError(
  "AnthropicFallbackCacheCorruptFields",
)<{
  readonly message: string;
}> {}

export type AnthropicFallbackCacheDecodeError =
  | AnthropicFallbackCacheMalformedSerialization
  | AnthropicFallbackCacheUnsupportedVersion
  | AnthropicFallbackCacheCorruptFields;

function corrupt(message: string): AnthropicFallbackCacheCorruptFields {
  return new AnthropicFallbackCacheCorruptFields({ message });
}

export function decodeAnthropicFallbackCacheRecord(serialized: string): ResultType<
  {
    readonly value: AnthropicFallbackCacheRecord;
    readonly provenance: "current";
  },
  AnthropicFallbackCacheDecodeError
> {
  const parsedResult = Result.try({
    try: (): unknown => JSON.parse(serialized),
    catch: () =>
      new AnthropicFallbackCacheMalformedSerialization({
        message: "Anthropic fallback cache index is not valid JSON",
      }),
  });
  const parsedOutcome = parsedResult.match<
    | { readonly kind: "success"; readonly parsed: unknown }
    | { readonly kind: "failure"; readonly error: AnthropicFallbackCacheMalformedSerialization }
  >({
    ok: (parsed) => ({ kind: "success", parsed }),
    err: (error) => ({ kind: "failure", error }),
  });
  if (parsedOutcome.kind === "failure") return Result.err(parsedOutcome.error);
  const { parsed } = parsedOutcome;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Result.err(corrupt("Anthropic fallback cache index must be an object"));
  }
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== 1) {
    return Result.err(
      new AnthropicFallbackCacheUnsupportedVersion({
        message: "Anthropic fallback cache index version is unsupported",
      }),
    );
  }
  if (
    typeof record["cachedAt"] !== "number" ||
    !Number.isSafeInteger(record["cachedAt"]) ||
    record["cachedAt"] < 0 ||
    typeof record["byteLength"] !== "number" ||
    !Number.isSafeInteger(record["byteLength"]) ||
    record["byteLength"] < 0 ||
    (record["mediaType"] !== undefined && typeof record["mediaType"] !== "string")
  ) {
    return Result.err(corrupt("Anthropic fallback cache index metadata is invalid"));
  }

  if (record["status"] === "oversize-image") {
    const expectedKeys = new Set(["version", "status", "mediaType", "byteLength", "cachedAt"]);
    if (Object.keys(record).some((key) => !expectedKeys.has(key))) {
      return Result.err(corrupt("Anthropic fallback oversize cache index has unknown fields"));
    }
    return Result.ok({
      value: {
        version: 1,
        status: "oversize-image",
        ...(record["mediaType"] === undefined ? {} : { mediaType: record["mediaType"] }),
        byteLength: record["byteLength"],
        cachedAt: record["cachedAt"],
      },
      provenance: "current",
    });
  }

  if (record["status"] !== "ok") {
    return Result.err(corrupt("Anthropic fallback cache index status is invalid"));
  }
  const expectedKeys = new Set([
    "version",
    "status",
    "mediaType",
    "byteLength",
    "cachedAt",
    "blob",
  ]);
  if (Object.keys(record).some((key) => !expectedKeys.has(key))) {
    return Result.err(corrupt("Anthropic fallback cache index has unknown fields"));
  }
  const decodedBlob = blobRefV1Schema.safeParse(record["blob"]);
  if (
    !decodedBlob.success ||
    decodedBlob.data.byteLength !== record["byteLength"] ||
    decodedBlob.data.expiresAt !== record["cachedAt"] + ANTHROPIC_FALLBACK_CACHE_TTL_MS
  ) {
    return Result.err(corrupt("Anthropic fallback index reference is invalid"));
  }
  return Result.ok({
    value: {
      version: 1,
      status: "ok",
      ...(record["mediaType"] === undefined ? {} : { mediaType: record["mediaType"] }),
      byteLength: record["byteLength"],
      cachedAt: record["cachedAt"],
      blob: decodedBlob.data,
    },
    provenance: "current",
  });
}

const fixtureCachedAt = 1_000;
const fixtureBlob = {
  version: 1,
  objectId: `b1_${"1".repeat(32)}`,
  sha256: "0".repeat(64),
  byteLength: 3,
  expiresAt: fixtureCachedAt + ANTHROPIC_FALLBACK_CACHE_TTL_MS,
} as const;
const fixtureCurrent = JSON.stringify({
  version: 1,
  status: "ok",
  mediaType: "application/pdf",
  byteLength: 3,
  cachedAt: fixtureCachedAt,
  blob: fixtureBlob,
});

export const anthropicFallbackCacheCodecCases = {
  current: { input: fixtureCurrent, outcome: "ok", provenance: "current" },
  legacy: {
    input: JSON.stringify({
      status: "ok",
      mediaType: "application/pdf",
      byteLength: 3,
      cachedAt: fixtureCachedAt,
    }),
    outcome: "error",
  },
  "missing-defaulted": {
    input: JSON.stringify({
      version: 1,
      status: "ok",
      cachedAt: fixtureCachedAt,
      blob: fixtureBlob,
    }),
    outcome: "error",
  },
  "unsupported-version": {
    input: JSON.stringify({
      version: 2,
      status: "ok",
      byteLength: 3,
      cachedAt: fixtureCachedAt,
      blob: fixtureBlob,
    }),
    outcome: "error",
  },
  "malformed-serialization": { input: "{", outcome: "error" },
  "corrupt-fields": {
    input: JSON.stringify({
      version: 1,
      status: "ok",
      byteLength: 3,
      cachedAt: fixtureCachedAt,
      blob: { ...fixtureBlob, expiresAt: fixtureBlob.expiresAt + 1 },
    }),
    outcome: "error",
  },
} as const;
