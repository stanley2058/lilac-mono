import { createDownload, type Experimental_DownloadFunction as DownloadFunction } from "ai";
import type { JSONObject } from "@stanley2058/lilac-utils";

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const ANTHROPIC_UPSTREAM_PROVIDER_ORDER = ["anthropic", "vertex", "bedrock"] as const;
const ANTHROPIC_FALLBACK_FORCE_DOWNLOAD_PROVIDERS = new Set([
  "vertex",
  "vertexAnthropic",
  "bedrock",
]);
const ANTHROPIC_FALLBACK_FORCE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const ANTHROPIC_FALLBACK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_FALLBACK_CACHE_DIR = "/tmp/lilac-anthropic-fallback-media";
const ANTHROPIC_FALLBACK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ANTHROPIC_FALLBACK_MEMORY_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const ANTHROPIC_FALLBACK_IMAGE_MAX_WIDTHS = [3072, 2560, 2048, 1600, 1280, 1024, 768, 512] as const;
const ANTHROPIC_FALLBACK_IMAGE_MIN_QUALITY = 55;
const ANTHROPIC_FALLBACK_IMAGE_MAX_QUALITY = 88;
const ANTHROPIC_FALLBACK_IMAGE_MAX_RENDER_ATTEMPTS = 5;
const downloadUrlForAnthropicFallback = createDownload({
  maxBytes: ANTHROPIC_FALLBACK_FORCE_DOWNLOAD_MAX_BYTES,
});

type AnthropicFallbackCacheRecord =
  | {
      status: "ok";
      mediaType?: string;
      byteLength: number;
      cachedAt: number;
    }
  | {
      status: "oversize-image";
      mediaType?: string;
      byteLength: number;
      cachedAt: number;
    };

type AnthropicFallbackMemoryEntry = AnthropicFallbackCacheRecord & {
  bytes?: Uint8Array;
};

type AnthropicFallbackImageFitResult = {
  data: Uint8Array;
  mediaType: string | undefined;
};

const anthropicFallbackMemoryCache = new Map<string, AnthropicFallbackMemoryEntry>();
const anthropicFallbackInflight = new Map<string, Promise<AnthropicFallbackImageFitResult>>();

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
    dataPath: path.join(cacheDir, `${key}.bin`),
    metaPath: path.join(cacheDir, `${key}.json`),
    originalPath: path.join(cacheDir, `${key}.orig`),
    resizedPath: path.join(cacheDir, `${key}.resized.jpg`),
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

async function runCommand(params: { cmd: string[] }): Promise<{ code: number; stderr: string }> {
  try {
    const proc = Bun.spawn(params.cmd, {
      stdout: "ignore",
      stderr: "pipe",
    });

    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    const code = await proc.exited;
    return { code, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: -1, stderr: message };
  }
}

function buildImageResizeCommands(params: {
  inputPath: string;
  outputPath: string;
  resize: string;
  quality: number;
}): string[][] {
  const commonArgs = [
    params.inputPath,
    "-auto-orient",
    "-strip",
    "-background",
    "white",
    "-alpha",
    "remove",
    "-alpha",
    "off",
    "-resize",
    params.resize,
    "-sampling-factor",
    "4:2:0",
    "-quality",
    String(params.quality),
    `jpeg:${params.outputPath}`,
  ];

  return [
    ["magick", ...commonArgs],
    ["convert", ...commonArgs],
  ];
}

async function renderAnthropicFallbackImageCandidate(params: {
  inputPath: string;
  outputPath: string;
  width: number;
  quality: number;
}): Promise<{ bytes?: Uint8Array; error?: string }> {
  await fs.rm(params.outputPath, { force: true }).catch(() => {});

  const resize = `${params.width}x${params.width}>`;
  let lastError = "";

  for (const command of buildImageResizeCommands({
    inputPath: params.inputPath,
    outputPath: params.outputPath,
    resize,
    quality: params.quality,
  })) {
    const result = await runCommand({ cmd: command });
    if (result.code !== 0) {
      lastError = result.stderr.trim();
      continue;
    }

    return { bytes: new Uint8Array(await fs.readFile(params.outputPath)) };
  }

  return { error: lastError || "image resize command failed" };
}

async function fitImageForAnthropicFallback(params: {
  url: URL;
  data: Uint8Array;
  mediaType: string | undefined;
  cacheDir: string;
}): Promise<AnthropicFallbackImageFitResult | null> {
  await fs.mkdir(params.cacheDir, { recursive: true });

  const paths = getAnthropicFallbackCachePaths(params.cacheDir, params.url);
  await fs.writeFile(paths.originalPath, params.data);

  let lastError = "";
  let renderAttempts = 0;
  try {
    for (const width of ANTHROPIC_FALLBACK_IMAGE_MAX_WIDTHS) {
      let low = ANTHROPIC_FALLBACK_IMAGE_MIN_QUALITY;
      let high = ANTHROPIC_FALLBACK_IMAGE_MAX_QUALITY;
      let bestBytes: Uint8Array | undefined;

      while (low <= high) {
        const quality = Math.floor((low + high) / 2);
        const rendered = await renderAnthropicFallbackImageCandidate({
          inputPath: paths.originalPath,
          outputPath: paths.resizedPath,
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
  } finally {
    await fs.rm(paths.originalPath, { force: true }).catch(() => {});
    await fs.rm(paths.resizedPath, { force: true }).catch(() => {});
  }

  if (lastError) {
    throw new Error(`Failed to resize image for Anthropic fallback: ${lastError}`);
  }

  return null;
}

async function readAnthropicFallbackCache(params: {
  url: URL;
  cacheDir: string;
  nowMs?: number;
}): Promise<AnthropicFallbackMemoryEntry | null> {
  const urlText = params.url.toString();
  const nowMs = params.nowMs ?? Date.now();
  const inMemory = anthropicFallbackMemoryCache.get(urlText);
  if (
    inMemory &&
    isFreshAnthropicFallbackCache(inMemory.cachedAt, nowMs) &&
    (inMemory.status === "oversize-image" || inMemory.bytes)
  ) {
    return inMemory;
  }

  const paths = getAnthropicFallbackCachePaths(params.cacheDir, params.url);
  let rawMeta: string;
  try {
    rawMeta = await fs.readFile(paths.metaPath, "utf8");
  } catch {
    anthropicFallbackMemoryCache.delete(urlText);
    return null;
  }

  let meta: AnthropicFallbackCacheRecord;
  try {
    meta = JSON.parse(rawMeta) as AnthropicFallbackCacheRecord;
  } catch {
    await fs.rm(paths.metaPath, { force: true }).catch(() => {});
    anthropicFallbackMemoryCache.delete(urlText);
    return null;
  }

  if (!isFreshAnthropicFallbackCache(meta.cachedAt, nowMs)) {
    anthropicFallbackMemoryCache.delete(urlText);
    await fs.rm(paths.metaPath, { force: true }).catch(() => {});
    await fs.rm(paths.dataPath, { force: true }).catch(() => {});
    return null;
  }

  if (meta.status === "oversize-image") {
    anthropicFallbackMemoryCache.set(urlText, meta);
    return meta;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(paths.dataPath));
  } catch {
    await fs.rm(paths.metaPath, { force: true }).catch(() => {});
    anthropicFallbackMemoryCache.delete(urlText);
    return null;
  }

  const entry: AnthropicFallbackMemoryEntry =
    bytes.byteLength <= ANTHROPIC_FALLBACK_MEMORY_CACHE_MAX_BYTES ? { ...meta, bytes } : meta;
  anthropicFallbackMemoryCache.set(urlText, entry);
  return entry.bytes ? entry : { ...entry, bytes };
}

async function writeAnthropicFallbackCache(params: {
  url: URL;
  cacheDir: string;
  entry: AnthropicFallbackCacheRecord;
  bytes?: Uint8Array;
}): Promise<void> {
  await fs.mkdir(params.cacheDir, { recursive: true, mode: 0o700 });
  await fs.chmod(params.cacheDir, 0o700).catch(() => {});
  const paths = getAnthropicFallbackCachePaths(params.cacheDir, params.url);

  if (params.entry.status === "ok" && params.bytes) {
    await fs.writeFile(paths.dataPath, params.bytes, { mode: 0o600 });
    await fs.chmod(paths.dataPath, 0o600).catch(() => {});
  } else {
    await fs.rm(paths.dataPath, { force: true }).catch(() => {});
  }

  await fs.writeFile(paths.metaPath, JSON.stringify(params.entry), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(paths.metaPath, 0o600).catch(() => {});

  const memoryEntry: AnthropicFallbackMemoryEntry =
    params.entry.status === "ok" &&
    params.bytes &&
    params.bytes.byteLength <= ANTHROPIC_FALLBACK_MEMORY_CACHE_MAX_BYTES
      ? { ...params.entry, bytes: params.bytes }
      : params.entry;
  anthropicFallbackMemoryCache.set(params.url.toString(), memoryEntry);
}

async function resolveAnthropicFallbackDownload(params: {
  url: URL;
  cacheDir: string;
  downloadUrl: (url: URL) => Promise<{ data: Uint8Array; mediaType: string | undefined }>;
  fitImage?: (input: {
    url: URL;
    data: Uint8Array;
    mediaType: string | undefined;
    cacheDir: string;
  }) => Promise<AnthropicFallbackImageFitResult | null>;
}): Promise<AnthropicFallbackImageFitResult> {
  const urlText = params.url.toString();
  const cached = await readAnthropicFallbackCache({
    url: params.url,
    cacheDir: params.cacheDir,
  });
  if (cached) {
    if (cached.status === "oversize-image") {
      throw new Error(
        formatAnthropicFallbackImageTooLargeError({
          url: params.url,
          byteLength: cached.byteLength,
        }),
      );
    }

    if (cached.bytes) {
      return { data: cached.bytes, mediaType: cached.mediaType };
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
        cacheDir: params.cacheDir,
      });

      if (!fitted || fitted.data.byteLength > ANTHROPIC_FALLBACK_IMAGE_MAX_BYTES) {
        const entry: AnthropicFallbackCacheRecord = {
          status: "oversize-image",
          mediaType,
          byteLength: data.byteLength,
          cachedAt: Date.now(),
        };
        await writeAnthropicFallbackCache({
          url: params.url,
          cacheDir: params.cacheDir,
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

    const entry: AnthropicFallbackCacheRecord = {
      status: "ok",
      mediaType,
      byteLength: data.byteLength,
      cachedAt: Date.now(),
    };
    await writeAnthropicFallbackCache({
      url: params.url,
      cacheDir: params.cacheDir,
      entry,
      bytes: data,
    });

    return { data, mediaType };
  })();

  anthropicFallbackInflight.set(urlText, promise);
  try {
    return await promise;
  } finally {
    anthropicFallbackInflight.delete(urlText);
  }
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
  downloadUrl?: (url: URL) => Promise<{ data: Uint8Array; mediaType: string | undefined }>;
  cacheDir?: string;
  fitImage?: (input: {
    url: URL;
    data: Uint8Array;
    mediaType: string | undefined;
    cacheDir: string;
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
          downloadUrl,
          fitImage: params.fitImage,
        });
      }),
    );
  };
}
