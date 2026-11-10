import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  createMemoryBlobStore,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";

import { buildExperimentalDownloadForAnthropicFallback } from "../../src/agent/anthropic-fallback-media";
import {
  anthropicFallbackCacheCodecCases,
  decodeAnthropicFallbackCacheRecord,
} from "../../src/agent/anthropic-fallback-cache-codec";

const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

function cacheIndexPath(cacheDir: string, url: URL): string {
  const key = createHash("sha256").update(url.toString()).digest("hex");
  return path.join(cacheDir, `${key}.json`);
}

function createOversizeBitmap(): Uint8Array {
  const edge = 1_323;
  const pixelOffset = 54;
  const rowStride = (edge * 3 + 3) & ~3;
  const image = new Uint8Array(pixelOffset + rowStride * edge);
  const header = new DataView(image.buffer);
  image.set([0x42, 0x4d]);
  header.setUint32(2, image.byteLength, true);
  header.setUint32(10, pixelOffset, true);
  header.setUint32(14, 40, true);
  header.setInt32(18, edge, true);
  header.setInt32(22, edge, true);
  header.setUint16(26, 1, true);
  header.setUint16(28, 24, true);
  header.setUint32(34, rowStride * edge, true);
  image.fill(255, pixelOffset);
  return image;
}

async function uploadForTest(blobStore: BlobStore, bytes: Uint8Array): Promise<BlobRefV1> {
  const started = await blobStore.startUpload({
    source: bytes,
    retention: { kind: "expires", expiresAt: Date.now() + CACHE_TTL_MS },
  });
  if (started.status === "error") throw started.error;
  const completed = await started.value.completion;
  if (completed.status === "error") throw completed.error;
  return completed.value;
}

function buildDownload(params: {
  blobStore: BlobStore;
  cacheDir: string;
  downloadUrl: () => Promise<{ data: Uint8Array; mediaType: string | undefined }>;
}) {
  const download = buildExperimentalDownloadForAnthropicFallback({
    blobStore: params.blobStore,
    spec: "vercel/anthropic/claude-opus-4.6",
    provider: "vercel",
    providerOptions: { gateway: { order: ["vertex", "anthropic", "bedrock"] } },
    cacheDir: params.cacheDir,
    downloadUrl: params.downloadUrl,
  });
  if (!download) throw new Error("Expected an Anthropic fallback download hook");
  return download;
}

describe("Anthropic fallback blob cache", () => {
  let blobStore: BlobStore;

  beforeAll(async () => {
    const created = await createMemoryBlobStore();
    if (created.status === "error") throw created.error;
    blobStore = created.value;
  });

  afterAll(async () => {
    await blobStore.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  it("strictly decodes the current cache index and rejects legacy state", () => {
    for (const fixture of Object.values(anthropicFallbackCacheCodecCases)) {
      const decoded = decodeAnthropicFallbackCacheRecord(fixture.input);
      expect(decoded.status).toBe(fixture.outcome === "ok" ? "ok" : "error");
      if (decoded.status === "ok" && "provenance" in fixture) {
        expect(decoded.value.provenance).toBe(fixture.provenance);
      }
    }
  });

  it("stores cache content in BlobStore and keeps only a structured index file", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    const url = new URL("https://example.com/report.pdf?test=blob-backed-cache");
    let calls = 0;
    const download = buildDownload({
      blobStore,
      cacheDir,
      downloadUrl: async () => {
        calls += 1;
        return { data: new Uint8Array([9, 8, 7, 6]), mediaType: "application/pdf" };
      },
    });

    try {
      const request = [{ url, isUrlSupportedByModel: true }];
      const first = await download(request);
      const second = await download(request);

      expect(calls).toBe(1);
      expect(second).toEqual(first);
      expect(await readdir(cacheDir)).toEqual([path.basename(cacheIndexPath(cacheDir, url))]);
      const index = JSON.parse(await readFile(cacheIndexPath(cacheDir, url), "utf8")) as {
        cachedAt: number;
        blob: { expiresAt: number };
      };
      expect(index.blob.expiresAt - index.cachedAt).toBe(CACHE_TTL_MS);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("streams oversized image resizing without leaving source or output payload files", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-resize-"));
    const url = new URL("https://example.com/oversized.bmp?test=streamed-resize");
    const source = createOversizeBitmap();
    const download = buildDownload({
      blobStore,
      cacheDir,
      downloadUrl: async () => ({ data: source, mediaType: "image/bmp" }),
    });

    try {
      const [result] = await download([{ url, isUrlSupportedByModel: true }]);

      expect(result?.mediaType).toBe("image/jpeg");
      expect(result?.data.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(await readdir(cacheDir)).toEqual([path.basename(cacheIndexPath(cacheDir, url))]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("leaves no resize payload residue when the converter rejects the source", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "lilac-fallback-resize-failure-"));
    const cacheDir = path.join(sandbox, "cache");
    const url = new URL("https://example.com/invalid.png?test=streamed-resize-failure");
    const download = buildDownload({
      blobStore,
      cacheDir,
      downloadUrl: async () => ({
        data: new Uint8Array(5 * 1024 * 1024 + 1),
        mediaType: "image/png",
      }),
    });

    try {
      await expect(download([{ url, isUrlSupportedByModel: true }])).rejects.toThrow(
        "Failed to resize image for Anthropic fallback",
      );
      expect(await readdir(sandbox)).toEqual([]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("treats missing, expired, and corrupt blobs as cache misses", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    const urls = [
      new URL("https://example.com/missing.pdf?test=blob-cache-miss"),
      new URL("https://example.com/expired.pdf?test=blob-cache-miss"),
      new URL("https://example.com/corrupt.pdf?test=blob-cache-miss"),
    ];
    const now = Date.now();
    const corruptRef = await uploadForTest(blobStore, new Uint8Array([7, 7, 7]));
    const records = [
      {
        version: 1,
        status: "ok",
        byteLength: 3,
        cachedAt: now,
        blob: {
          version: 1,
          objectId: `b1_${"1".repeat(32)}`,
          sha256: "0".repeat(64),
          byteLength: 3,
          expiresAt: now + CACHE_TTL_MS,
        },
      },
      {
        version: 1,
        status: "ok",
        byteLength: 3,
        cachedAt: now - CACHE_TTL_MS - 1,
        blob: {
          version: 1,
          objectId: `b1_${"2".repeat(32)}`,
          sha256: "0".repeat(64),
          byteLength: 3,
          expiresAt: now - 1,
        },
      },
      {
        version: 1,
        status: "ok",
        byteLength: 3,
        cachedAt: corruptRef.expiresAt! - CACHE_TTL_MS,
        blob: { ...corruptRef, sha256: "0".repeat(64) },
      },
    ];
    for (const [index, url] of urls.entries()) {
      await writeFile(cacheIndexPath(cacheDir, url), JSON.stringify(records[index]));
    }

    let calls = 0;
    const download = buildDownload({
      blobStore,
      cacheDir,
      downloadUrl: async () => {
        calls += 1;
        return { data: new Uint8Array([1, 2, 3]), mediaType: "application/pdf" };
      },
    });

    try {
      const results = await download(urls.map((url) => ({ url, isUrlSupportedByModel: true })));
      expect(calls).toBe(3);
      expect(results).toHaveLength(3);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
