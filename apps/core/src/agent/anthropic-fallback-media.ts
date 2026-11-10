import { captureError } from "../shared/error-capture";
import { Result, type Result as ResultType } from "better-result";
import { createDownload, type Experimental_DownloadFunction as DownloadFunction } from "ai";
import {
  materializeBlobRead,
  type BlobRead,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { opaqueErrorMessage, type JSONObject } from "@stanley2058/lilac-utils";

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  ANTHROPIC_FALLBACK_CACHE_TTL_MS,
  decodeAnthropicFallbackCacheRecord,
  type AnthropicFallbackCacheDecodeError,
  type AnthropicFallbackCacheRecord,
} from "./anthropic-fallback-cache-codec";

const ANTHROPIC_UPSTREAM_PROVIDER_ORDER = ["anthropic", "vertex", "bedrock"] as const;
const ANTHROPIC_FALLBACK_FORCE_DOWNLOAD_PROVIDERS = new Set([
  "vertex",
  "vertexAnthropic",
  "bedrock",
]);
const ANTHROPIC_FALLBACK_FORCE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const ANTHROPIC_FALLBACK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_FALLBACK_CACHE_DIR = "/tmp/lilac-anthropic-fallback-media";
const ANTHROPIC_FALLBACK_IMAGE_MAX_WIDTHS = [3072, 2560, 2048, 1600, 1280, 1024, 768, 512] as const;
const ANTHROPIC_FALLBACK_IMAGE_MIN_QUALITY = 55;
const ANTHROPIC_FALLBACK_IMAGE_MAX_QUALITY = 88;
const ANTHROPIC_FALLBACK_IMAGE_MAX_RENDER_ATTEMPTS = 5;
const downloadUrlForAnthropicFallback = createDownload({
  maxBytes: ANTHROPIC_FALLBACK_FORCE_DOWNLOAD_MAX_BYTES,
});

async function ignoreFallbackFsFailure(operation: () => Promise<unknown>): Promise<void> {
  await Result.tryPromise({ try: operation, catch: () => undefined });
}

type AnthropicFallbackImageFitResult = {
  data: Uint8Array;
  mediaType: string | undefined;
};

type AnthropicFallbackCacheWriteRecord =
  | Omit<Extract<AnthropicFallbackCacheRecord, { status: "ok" }>, "blob">
  | Extract<AnthropicFallbackCacheRecord, { status: "oversize-image" }>;

type AnthropicFallbackCacheReadDecision = {
  readonly read: BlobRead | null;
  readonly remove: boolean;
};

type AnthropicFallbackCacheMaterializeDecision = {
  readonly bytes: Uint8Array | null;
  readonly remove: boolean;
};

const anthropicFallbackMemoryCache = new Map<string, AnthropicFallbackCacheRecord>();
const anthropicFallbackInflight = new Map<string, Promise<AnthropicFallbackImageFitResult>>();

export type AnthropicFallbackBlobStore = BlobStore;

export function isAnthropicModelSpec(spec: string): boolean {
  return spec.startsWith("anthropic/") || spec.includes("/anthropic/");
}

function readProviderOrder(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }

  return value;
}

function getAnthropicUpstreamProviderOrder(
  provider: string,
  providerOptions: { [x: string]: JSONObject } | undefined,
): readonly string[] | undefined {
  const base = providerOptions ?? {};

  if (provider === "vercel") {
    const gateway = base["gateway"];
    if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
      return undefined;
    }
    return readProviderOrder((gateway as JSONObject)["order"]);
  }

  if (provider === "openrouter") {
    const openRouter = base["openrouter"];
    if (!openRouter || typeof openRouter !== "object" || Array.isArray(openRouter)) {
      return undefined;
    }

    const providerBlock = (openRouter as JSONObject)["provider"];
    if (!providerBlock || typeof providerBlock !== "object" || Array.isArray(providerBlock)) {
      return undefined;
    }

    return readProviderOrder((providerBlock as JSONObject)["order"]);
  }

  return undefined;
}

function getAnthropicUpstreamProviderOnly(
  provider: string,
  providerOptions: { [x: string]: JSONObject } | undefined,
): readonly string[] | undefined {
  const base = providerOptions ?? {};

  if (provider === "vercel") {
    const gateway = base["gateway"];
    if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
      return undefined;
    }
    return readProviderOrder((gateway as JSONObject)["only"]);
  }

  if (provider === "openrouter") {
    const openRouter = base["openrouter"];
    if (!openRouter || typeof openRouter !== "object" || Array.isArray(openRouter)) {
      return undefined;
    }

    const providerBlock = (openRouter as JSONObject)["provider"];
    if (!providerBlock || typeof providerBlock !== "object" || Array.isArray(providerBlock)) {
      return undefined;
    }

    return readProviderOrder((providerBlock as JSONObject)["only"]);
  }

  return undefined;
}

function normalizeMediaType(mediaType: string | undefined): string | undefined {
  if (!mediaType) return undefined;
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function isImageUrlPathname(pathname: string): boolean {
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/iu.test(pathname);
}

function isLikelyImageAsset(params: { url: URL; mediaType: string | undefined }): boolean {
  if (params.mediaType?.startsWith("image/")) return true;
  return isImageUrlPathname(params.url.pathname);
}

function getAnthropicFallbackCachePaths(cacheDir: string, url: URL) {
  const key = createHash("sha256").update(url.toString()).digest("hex");
  return {
    metaPath: path.join(cacheDir, `${key}.json`),
  };
}

function isFreshAnthropicFallbackCache(cachedAt: number, nowMs: number): boolean {
  return nowMs - cachedAt <= ANTHROPIC_FALLBACK_CACHE_TTL_MS;
}

function formatAnthropicFallbackImageTooLargeError(params: {
  url: URL;
  byteLength: number;
}): string {
  return `Image attachment too large for Anthropic fallback uploads (${params.byteLength} bytes > ${ANTHROPIC_FALLBACK_IMAGE_MAX_BYTES} byte limit): ${params.url.toString()}. Send a smaller image, or pin routing to a provider that supports image URLs.`;
}

async function renderAnthropicFallbackImageCandidate(params: {
  data: Uint8Array;
  width: number;
  quality: number;
}): Promise<{ bytes?: Uint8Array; error?: string }> {
  {
    const attempt = await Result.tryPromise({
      try: () =>
        new Bun.Image(params.data, { autoOrient: true })
          .resize(params.width, params.width, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ progressive: false, quality: params.quality })
          .bytes(),
      catch: captureError,
    });

    if (attempt.isErr()) {
      const message = opaqueErrorMessage(attempt.error.cause, "Unknown media conversion failure");
      return { error: message };
    }
    return { bytes: attempt.value };
  }
}

async function fitImageForAnthropicFallback(params: {
  url: URL;
  data: Uint8Array;
  mediaType: string | undefined;
}): Promise<AnthropicFallbackImageFitResult | null> {
  let lastError = "";
  let renderAttempts = 0;
  for (const width of ANTHROPIC_FALLBACK_IMAGE_MAX_WIDTHS) {
    let low = ANTHROPIC_FALLBACK_IMAGE_MIN_QUALITY;
    let high = ANTHROPIC_FALLBACK_IMAGE_MAX_QUALITY;
    let bestBytes: Uint8Array | undefined;

    while (low <= high) {
      const quality = Math.floor((low + high) / 2);
      const rendered = await renderAnthropicFallbackImageCandidate({
        data: params.data,
        width,
        quality,
      });

      if (!rendered.bytes) {
        lastError = rendered.error ?? lastError;
        break;
      }

      renderAttempts += 1;

      if (rendered.bytes.byteLength <= ANTHROPIC_FALLBACK_IMAGE_MAX_BYTES) {
        bestBytes = rendered.bytes;
        if (renderAttempts >= ANTHROPIC_FALLBACK_IMAGE_MAX_RENDER_ATTEMPTS) {
          return {
            data: bestBytes,
            mediaType: "image/jpeg",
          };
        }
        low = quality + 1;
        continue;
      }

      high = quality - 1;
    }

    if (!bestBytes) {
      continue;
    }

    return {
      data: bestBytes,
      mediaType: "image/jpeg",
    };
  }

  if (lastError) {
    throw new Error(`Failed to resize image for Anthropic fallback: ${lastError}`);
  }

  return null;
}

async function readAnthropicFallbackCache(params: {
  url: URL;
  cacheDir: string;
  blobStore: BlobStore;
  nowMs?: number;
}): Promise<AnthropicFallbackImageFitResult | AnthropicFallbackCacheRecord | null> {
  const urlText = params.url.toString();
  const nowMs = params.nowMs ?? Date.now();
  const inMemory = anthropicFallbackMemoryCache.get(urlText);
  const paths = getAnthropicFallbackCachePaths(params.cacheDir, params.url);
  let meta = inMemory && isFreshAnthropicFallbackCache(inMemory.cachedAt, nowMs) ? inMemory : null;
  if (!meta) {
    const indexed = await readAnthropicFallbackCacheIndex({ metaPath: paths.metaPath });
    const indexDecision = indexed.match({
      ok: (record) => ({ record, remove: false }),
      err: () => ({ record: null, remove: true }),
    });
    meta = indexDecision.record;
    if (indexDecision.remove) {
      await ignoreFallbackFsFailure(() => fs.rm(paths.metaPath, { force: true }));
    }
  }

  if (!meta) {
    anthropicFallbackMemoryCache.delete(urlText);
    return null;
  }

  if (!isFreshAnthropicFallbackCache(meta.cachedAt, nowMs)) {
    await removeAnthropicFallbackCacheEntry({
      urlText,
      metaPath: paths.metaPath,
      blobStore: params.blobStore,
      record: meta,
    });
    return null;
  }

  if (meta.status === "oversize-image") {
    anthropicFallbackMemoryCache.set(urlText, meta);
    return meta;
  }

  const opened = await params.blobStore.open(meta.blob);
  const readDecision: AnthropicFallbackCacheReadDecision = opened.match({
    ok: (value): AnthropicFallbackCacheReadDecision => ({ read: value, remove: false }),
    err: (error): AnthropicFallbackCacheReadDecision => {
      switch (error._tag) {
        case "BlobInvalidReference":
        case "BlobObjectAbsent":
        case "BlobObjectExpired":
        case "BlobIntegrityFailure":
          return { read: null, remove: true };
        case "BlobAdapterFailure":
          return { read: null, remove: false };
      }
    },
  });
  if (!readDecision.read) {
    if (readDecision.remove) {
      await removeAnthropicFallbackCacheEntry({
        urlText,
        metaPath: paths.metaPath,
        blobStore: params.blobStore,
        record: meta,
      });
    }
    return null;
  }

  const materialized = await materializeBlobRead(readDecision.read);
  const materializedDecision: AnthropicFallbackCacheMaterializeDecision = materialized.match({
    ok: (value): AnthropicFallbackCacheMaterializeDecision => ({ bytes: value, remove: false }),
    err: (error): AnthropicFallbackCacheMaterializeDecision => {
      switch (error._tag) {
        case "BlobIntegrityFailure":
          return { bytes: null, remove: true };
        case "BlobReadCancelled":
        case "BlobReadSourceFailure":
          return { bytes: null, remove: false };
      }
    },
  });
  if (!materializedDecision.bytes) {
    if (materializedDecision.remove) {
      await removeAnthropicFallbackCacheEntry({
        urlText,
        metaPath: paths.metaPath,
        blobStore: params.blobStore,
        record: meta,
      });
    }
    return null;
  }

  anthropicFallbackMemoryCache.set(urlText, meta);
  return { data: materializedDecision.bytes, mediaType: meta.mediaType };
}

export async function readAnthropicFallbackCacheIndex(params: {
  metaPath: string;
}): Promise<ResultType<AnthropicFallbackCacheRecord | null, AnthropicFallbackCacheDecodeError>> {
  const readMeta = (
    await Result.tryPromise({ try: () => fs.readFile(params.metaPath, "utf8"), catch: () => null })
  ).match({ ok: (rawMeta) => rawMeta, err: () => null });
  if (readMeta === null) return Result.ok(null);

  return decodeAnthropicFallbackCacheRecord(readMeta).map((decoded) => decoded.value);
}

async function removeAnthropicFallbackCacheEntry(params: {
  urlText: string;
  metaPath: string;
  blobStore: BlobStore;
  record: AnthropicFallbackCacheRecord;
}): Promise<void> {
  anthropicFallbackMemoryCache.delete(params.urlText);
  await ignoreFallbackFsFailure(() => fs.rm(params.metaPath, { force: true }));
  if (params.record.status === "ok") {
    await params.blobStore.delete(params.record.blob);
  }
}

async function writeAnthropicFallbackCache(
  params: {
    url: URL;
    cacheDir: string;
    blobStore: BlobStore;
  } & (
    | {
        entry: Extract<AnthropicFallbackCacheWriteRecord, { status: "ok" }>;
        bytes: Uint8Array;
      }
    | {
        entry: Extract<AnthropicFallbackCacheWriteRecord, { status: "oversize-image" }>;
        bytes?: never;
      }
  ),
): Promise<void> {
  await ignoreFallbackFsFailure(() => fs.mkdir(params.cacheDir, { recursive: true, mode: 0o700 }));
  await ignoreFallbackFsFailure(() => fs.chmod(params.cacheDir, 0o700));
  const paths = getAnthropicFallbackCachePaths(params.cacheDir, params.url);

  const entry = await prepareAnthropicFallbackCacheRecord(params);
  if (!entry) return;

  await ignoreFallbackFsFailure(() =>
    fs.writeFile(paths.metaPath, JSON.stringify(entry), {
      encoding: "utf8",
      mode: 0o600,
    }),
  );
  await ignoreFallbackFsFailure(() => fs.chmod(paths.metaPath, 0o600));
  anthropicFallbackMemoryCache.set(params.url.toString(), entry);
}

async function prepareAnthropicFallbackCacheRecord(
  params:
    | {
        entry: Extract<AnthropicFallbackCacheWriteRecord, { status: "ok" }>;
        bytes: Uint8Array;
        blobStore: BlobStore;
      }
    | {
        entry: Extract<AnthropicFallbackCacheWriteRecord, { status: "oversize-image" }>;
        bytes?: never;
        blobStore: BlobStore;
      },
): Promise<AnthropicFallbackCacheRecord | null> {
  if (params.entry.status === "oversize-image") return params.entry;
  if (!params.bytes) return null;
  const blob = await writeAnthropicFallbackCacheBlob({
    blobStore: params.blobStore,
    bytes: params.bytes,
    cachedAt: params.entry.cachedAt,
  });
  if (!blob) return null;
  return { ...params.entry, blob };
}

async function writeAnthropicFallbackCacheBlob(params: {
  blobStore: BlobStore;
  bytes: Uint8Array;
  cachedAt: number;
}): Promise<BlobRefV1 | null> {
  const started = await params.blobStore.startUpload({
    source: params.bytes,
    retention: {
      kind: "expires",
      expiresAt: params.cachedAt + ANTHROPIC_FALLBACK_CACHE_TTL_MS,
    },
    expectedByteLength: params.bytes.byteLength,
  });
  const upload = started.match({ ok: (value) => value, err: () => null });
  if (!upload) return null;
  return (await upload.completion).match({ ok: (blob) => blob, err: () => null });
}

async function resolveAnthropicFallbackDownload(params: {
  url: URL;
  cacheDir: string;
  blobStore: BlobStore;
  downloadUrl: (url: URL) => Promise<{ data: Uint8Array; mediaType: string | undefined }>;
  fitImage?: (input: {
    url: URL;
    data: Uint8Array;
    mediaType: string | undefined;
  }) => Promise<AnthropicFallbackImageFitResult | null>;
}): Promise<AnthropicFallbackImageFitResult> {
  const urlText = params.url.toString();
  const cached = await readAnthropicFallbackCache({
    url: params.url,
    cacheDir: params.cacheDir,
    blobStore: params.blobStore,
  });
  if (cached) {
    if ("data" in cached) {
      return cached;
    }

    if (cached.status === "oversize-image") {
      throw new Error(
        formatAnthropicFallbackImageTooLargeError({
          url: params.url,
          byteLength: cached.byteLength,
        }),
      );
    }
  }

  const inFlight = anthropicFallbackInflight.get(urlText);
  if (inFlight) {
    return inFlight;
  }

  const fitImage = params.fitImage ?? fitImageForAnthropicFallback;
  const promise = (async () => {
    const downloaded = await params.downloadUrl(params.url);
    let data = downloaded.data;
    let mediaType = normalizeMediaType(downloaded.mediaType);

    if (
      isLikelyImageAsset({ url: params.url, mediaType }) &&
      data.byteLength > ANTHROPIC_FALLBACK_IMAGE_MAX_BYTES
    ) {
      const fitted = await fitImage({
        url: params.url,
        data,
        mediaType,
      });

      if (!fitted || fitted.data.byteLength > ANTHROPIC_FALLBACK_IMAGE_MAX_BYTES) {
        const entry: AnthropicFallbackCacheWriteRecord = {
          version: 1,
          status: "oversize-image",
          mediaType,
          byteLength: data.byteLength,
          cachedAt: Date.now(),
        };
        await writeAnthropicFallbackCache({
          url: params.url,
          cacheDir: params.cacheDir,
          blobStore: params.blobStore,
          entry,
        });
        throw new Error(
          formatAnthropicFallbackImageTooLargeError({
            url: params.url,
            byteLength: data.byteLength,
          }),
        );
      }

      data = fitted.data;
      mediaType = normalizeMediaType(fitted.mediaType) ?? mediaType;
    }

    const entry: AnthropicFallbackCacheWriteRecord = {
      version: 1,
      status: "ok",
      mediaType,
      byteLength: data.byteLength,
      cachedAt: Date.now(),
    };
    await writeAnthropicFallbackCache({
      url: params.url,
      cacheDir: params.cacheDir,
      blobStore: params.blobStore,
      entry,
      bytes: data,
    });

    return { data, mediaType };
  })();

  anthropicFallbackInflight.set(urlText, promise);
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        return { status: "return", value: await promise } as const;
      },
      catch: captureError,
    });
    const cleanupAttempt = Result.try({
      try: () => {
        anthropicFallbackInflight.delete(urlText);
      },
      catch: captureError,
    });
    if (cleanupAttempt.isErr()) throw cleanupAttempt.error.cause;
    if (attempt.isErr()) throw attempt.error.cause;
    if (attempt.value.status === "return") return attempt.value.value;
  }
  return undefined as never;
}

export function withStableAnthropicUpstreamOrder(
  provider: string,
  providerOptions: { [x: string]: JSONObject } | undefined,
): { [x: string]: JSONObject } | undefined {
  const base = providerOptions ?? {};

  if (provider === "vercel") {
    const existingGateway = (base["gateway"] as JSONObject | undefined) ?? {};
    const existingOrder = readProviderOrder(existingGateway["order"]);
    if (existingOrder) {
      return providerOptions;
    }

    return {
      ...base,
      gateway: {
        ...existingGateway,
        order: [...ANTHROPIC_UPSTREAM_PROVIDER_ORDER],
      },
    };
  }

  if (provider === "openrouter") {
    const existingOpenRouter = (base["openrouter"] as JSONObject | undefined) ?? {};
    const existingProvider =
      (existingOpenRouter["provider"] as Record<string, unknown> | undefined) ?? {};
    const existingOrder = readProviderOrder(existingProvider["order"]);
    if (existingOrder) {
      return providerOptions;
    }

    return {
      ...base,
      openrouter: {
        ...existingOpenRouter,
        provider: {
          ...existingProvider,
          order: [...ANTHROPIC_UPSTREAM_PROVIDER_ORDER],
        },
      },
    };
  }

  return providerOptions;
}

export function shouldForceUrlDownloadForAnthropicFallback(params: {
  spec: string;
  provider: string;
  providerOptions: { [x: string]: JSONObject } | undefined;
}): boolean {
  if (!isAnthropicModelSpec(params.spec)) return false;

  const only = getAnthropicUpstreamProviderOnly(params.provider, params.providerOptions);
  if (only) {
    return only.some((entry) => ANTHROPIC_FALLBACK_FORCE_DOWNLOAD_PROVIDERS.has(entry));
  }

  const order = getAnthropicUpstreamProviderOrder(params.provider, params.providerOptions);
  if (!order) return false;

  return order.some((entry) => ANTHROPIC_FALLBACK_FORCE_DOWNLOAD_PROVIDERS.has(entry));
}

export function buildExperimentalDownloadForAnthropicFallback(params: {
  spec: string;
  provider: string;
  providerOptions: { [x: string]: JSONObject } | undefined;
  blobStore: AnthropicFallbackBlobStore;
  downloadUrl?: (url: URL) => Promise<{ data: Uint8Array; mediaType: string | undefined }>;
  cacheDir?: string;
  fitImage?: (input: {
    url: URL;
    data: Uint8Array;
    mediaType: string | undefined;
  }) => Promise<AnthropicFallbackImageFitResult | null>;
}): DownloadFunction | undefined {
  if (!shouldForceUrlDownloadForAnthropicFallback(params)) {
    return undefined;
  }

  const downloadUrl =
    params.downloadUrl ?? ((url: URL) => downloadUrlForAnthropicFallback({ url }));
  const cacheDir = params.cacheDir ?? ANTHROPIC_FALLBACK_CACHE_DIR;

  return async (downloads) => {
    return Promise.all(
      downloads.map(async ({ url, isUrlSupportedByModel }) => {
        if (url.protocol !== "http:" && url.protocol !== "https:" && isUrlSupportedByModel) {
          return null;
        }

        return resolveAnthropicFallbackDownload({
          url,
          cacheDir,
          blobStore: params.blobStore,
          downloadUrl,
          fitImage: params.fitImage,
        });
      }),
    );
  };
}
