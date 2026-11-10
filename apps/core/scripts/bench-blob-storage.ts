import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import {
  materializeBlobRead,
  type BlobHandleV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  createBlobBenchmarkTargetStore,
  loadBlobBenchmarkTargetConfig,
} from "./blob-benchmark-target";

const IMAGE_WIDTH = 592;
const IMAGE_HEIGHT = 590;
const BMP_HEADER_BYTES = 54;
const BMP_ROW_BYTES = IMAGE_WIDTH * 3;
export const BENCHMARK_IMAGE_BYTES = BMP_HEADER_BYTES + BMP_ROW_BYTES * IMAGE_HEIGHT;

export type BlobStorageBenchmarkOptions = {
  readonly configPath: string;
  readonly dataDir: string;
  readonly warmups: number;
  readonly runs: number;
  readonly targetMs: number;
};

export type BlobStorageBenchmarkSample = {
  readonly reservationMs: number;
  readonly readyMs: number;
  readonly verifiedMs: number;
};

export class BlobStorageBenchmarkFailed extends TaggedError("BlobStorageBenchmarkFailed")<{
  readonly message: string;
}> {}

export class BlobStorageBenchmarkTargetMissed extends TaggedError(
  "BlobStorageBenchmarkTargetMissed",
)<{
  readonly targetMs: number;
  readonly maximumMs: number;
  readonly message: string;
}> {}

type BlobStorageBenchmarkError = BlobStorageBenchmarkFailed | BlobStorageBenchmarkTargetMissed;

function benchmarkFailure(message: string): BlobStorageBenchmarkFailed {
  return new BlobStorageBenchmarkFailed({ message });
}

function parsePositiveNumber(
  raw: string | undefined,
  name: string,
): ResultType<number, BlobStorageBenchmarkFailed> {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return Result.err(benchmarkFailure(`${name} must be a positive number`));
  }
  return Result.ok(value);
}

function parsePositiveInteger(
  raw: string | undefined,
  name: string,
): ResultType<number, BlobStorageBenchmarkFailed> {
  return parsePositiveNumber(raw, name).andThen((value) =>
    Number.isSafeInteger(value)
      ? Result.ok(value)
      : Result.err(benchmarkFailure(`${name} must be a positive integer`)),
  );
}

export function parseBlobStorageBenchmarkArgs(
  argv: readonly string[],
): ResultType<BlobStorageBenchmarkOptions | "help", BlobStorageBenchmarkFailed> {
  const parsed = Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          config: { type: "string" },
          "data-dir": { type: "string" },
          warmups: { type: "string", default: "2" },
          runs: { type: "string", default: "10" },
          "target-ms": { type: "string", default: "100" },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
      }),
    catch: () => benchmarkFailure("Invalid blob storage benchmark arguments"),
  });
  return parsed.andThen(({ values }) => {
    if (values.help) return Result.ok<"help">("help");
    const configPath = values.config;
    const dataDir = values["data-dir"];
    if (!configPath) return Result.err(benchmarkFailure("--config is required"));
    if (!dataDir) return Result.err(benchmarkFailure("--data-dir is required"));
    return Result.gen(function* () {
      const warmups = yield* parsePositiveInteger(values.warmups, "--warmups");
      const runs = yield* parsePositiveInteger(values.runs, "--runs");
      const targetMs = yield* parsePositiveNumber(values["target-ms"], "--target-ms");
      return Result.ok({
        configPath: path.resolve(configPath),
        dataDir: path.resolve(dataDir),
        warmups,
        runs,
        targetMs,
      });
    });
  });
}

export function generateBenchmarkBmp(): Uint8Array {
  const image = new Uint8Array(BENCHMARK_IMAGE_BYTES);
  const view = new DataView(image.buffer);
  image[0] = 0x42;
  image[1] = 0x4d;
  view.setUint32(2, image.byteLength, true);
  view.setUint32(10, BMP_HEADER_BYTES, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, IMAGE_WIDTH, true);
  view.setInt32(22, IMAGE_HEIGHT, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, image.byteLength - BMP_HEADER_BYTES, true);
  let state = 0x9e3779b9;
  for (let offset = BMP_HEADER_BYTES; offset < image.byteLength; offset += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    image[offset] = state & 0xff;
  }
  return image;
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function runSample(input: {
  readonly store: BlobStore;
  readonly imagePath: string;
  readonly expectedSha256: string;
  readonly handles: BlobHandleV1[];
}): Promise<ResultType<BlobStorageBenchmarkSample, BlobStorageBenchmarkFailed>> {
  return Result.gen(async function* () {
    const startedAt = performance.now();
    const upload = yield* Result.await(
      input.store
        .startUpload({
          source: Bun.file(input.imagePath).stream(),
          retention: { kind: "durable" },
          expectedSha256: input.expectedSha256,
          expectedByteLength: BENCHMARK_IMAGE_BYTES,
        })
        .then((result) => result.mapError(() => benchmarkFailure("Upload reservation failed"))),
    );
    input.handles.push(upload.handle);
    const reservedAt = performance.now();
    const ref = yield* Result.await(
      upload.completion.then((result) =>
        result.mapError(() => benchmarkFailure("Upload completion failed")),
      ),
    );
    const readyAt = performance.now();
    const read = yield* Result.await(
      input.store
        .open(ref)
        .then((result) => result.mapError(() => benchmarkFailure("Uploaded object open failed"))),
    );
    yield* Result.await(
      materializeBlobRead(read).then((result) =>
        result.mapError(() => benchmarkFailure("Uploaded object verification failed")),
      ),
    );
    const verifiedAt = performance.now();
    return Result.ok({
      reservationMs: reservedAt - startedAt,
      readyMs: readyAt - startedAt,
      verifiedMs: verifiedAt - startedAt,
    });
  });
}

async function cleanupHandles(
  store: BlobStore,
  handles: readonly BlobHandleV1[],
): Promise<ResultType<void, BlobStorageBenchmarkFailed>> {
  for (const handle of handles) {
    const deleted = await store.delete(handle);
    const error = deleted.match<BlobStorageBenchmarkFailed | null>({
      ok: () => null,
      err: () => benchmarkFailure("Benchmark object cleanup failed"),
    });
    if (error !== null) return Result.err(error);
  }
  return Result.ok(undefined);
}

async function removeBenchmarkDirectory(
  directory: string,
): Promise<ResultType<void, BlobStorageBenchmarkFailed>> {
  return (
    await Result.tryPromise({
      try: async () => fs.rm(directory, { recursive: true, force: true }),
      catch: () => benchmarkFailure("Benchmark image cleanup failed"),
    })
  ).map(() => undefined);
}

export async function runBlobStorageBenchmark(
  options: BlobStorageBenchmarkOptions,
): Promise<ResultType<readonly BlobStorageBenchmarkSample[], BlobStorageBenchmarkError>> {
  const prepared = await Result.tryPromise({
    try: async () => {
      const directory = await fs.mkdtemp(path.join(tmpdir(), "lilac-blob-benchmark-"));
      const imagePath = path.join(directory, "generated-1m.bmp");
      const image = generateBenchmarkBmp();
      await fs.writeFile(imagePath, image);
      return { directory, imagePath, image };
    },
    catch: () => benchmarkFailure("Could not create the generated benchmark image"),
  });
  const setup = prepared.match({ ok: (value) => value, err: () => null });
  if (setup === null) return prepared.map(() => []);

  const loaded = await loadBlobBenchmarkTargetConfig({
    configPath: options.configPath,
    dataDir: options.dataDir,
  });
  const target = loaded.match({ ok: (value) => value.target, err: () => null });
  if (target === null) {
    await removeBenchmarkDirectory(setup.directory);
    return Result.err(benchmarkFailure("Blob storage benchmark configuration failed"));
  }
  const created = await createBlobBenchmarkTargetStore(target);
  const store = created.match({ ok: (value) => value, err: () => null });
  if (store === null) {
    await removeBenchmarkDirectory(setup.directory);
    return Result.err(benchmarkFailure("Blob storage benchmark store creation failed"));
  }

  const handles: BlobHandleV1[] = [];
  const expectedSha256 = createHash("sha256").update(setup.image).digest("hex");
  const samples: BlobStorageBenchmarkSample[] = [];
  let operationError: BlobStorageBenchmarkError | null = null;
  for (let index = 0; index < options.warmups + options.runs; index += 1) {
    const sample = await runSample({
      store,
      imagePath: setup.imagePath,
      expectedSha256,
      handles,
    });
    const outcome = sample.match<
      | { readonly kind: "sample"; readonly sample: BlobStorageBenchmarkSample }
      | { readonly kind: "error"; readonly error: BlobStorageBenchmarkFailed }
    >({
      ok: (value) => ({ kind: "sample", sample: value }),
      err: (error) => ({ kind: "error", error }),
    });
    if (outcome.kind === "error") {
      operationError = outcome.error;
      break;
    }
    if (index >= options.warmups) {
      samples.push(outcome.sample);
      process.stdout.write(
        `sample=${samples.length} reservation_ms=${outcome.sample.reservationMs.toFixed(2)} ready_ms=${outcome.sample.readyMs.toFixed(2)} verified_ms=${outcome.sample.verifiedMs.toFixed(2)}\n`,
      );
    }
  }

  const handlesCleaned = await cleanupHandles(store, handles);
  const closed = await store.close({ deadlineAtMs: Date.now() + 30_000 });
  const directoryRemoved = await removeBenchmarkDirectory(setup.directory);
  const cleanupFailed =
    handlesCleaned.match({ ok: () => false, err: () => true }) ||
    closed.match({ ok: () => false, err: () => true }) ||
    directoryRemoved.match({ ok: () => false, err: () => true });
  if (operationError !== null) return Result.err(operationError);
  if (cleanupFailed) return Result.err(benchmarkFailure("Blob storage benchmark cleanup failed"));

  const readySamples = samples.map((sample) => sample.readyMs);
  const maximumMs = Math.max(...readySamples);
  process.stdout.write(
    `summary bytes=${BENCHMARK_IMAGE_BYTES} runs=${samples.length} median_ms=${percentile(readySamples, 0.5).toFixed(2)} p95_ms=${percentile(readySamples, 0.95).toFixed(2)} max_ms=${maximumMs.toFixed(2)} target_ms=${options.targetMs.toFixed(2)}\n`,
  );
  if (maximumMs >= options.targetMs) {
    return Result.err(
      new BlobStorageBenchmarkTargetMissed({
        targetMs: options.targetMs,
        maximumMs,
        message: `Blob storage benchmark exceeded ${options.targetMs.toFixed(2)} ms`,
      }),
    );
  }
  return Result.ok(samples);
}

const HELP_TEXT =
  "Usage: bun run bench:blob-storage -- --config PATH --data-dir PATH [--warmups N] [--runs N] [--target-ms N]";

if (import.meta.main) {
  const parsed = parseBlobStorageBenchmarkArgs(process.argv.slice(2));
  const run = parsed.match({
    ok: (options) => async () => {
      if (options === "help") {
        process.stdout.write(`${HELP_TEXT}\n`);
        return;
      }
      const benchmark = await runBlobStorageBenchmark(options);
      benchmark.match({
        ok: () => undefined,
        err: (error) => () => {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
        },
      })?.();
    },
    err: (error) => async () => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  });
  await run();
}
