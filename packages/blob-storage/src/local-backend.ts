import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import { Panic, Result, type Result as ResultType } from "better-result";

import {
  captureAdapterOperation,
  expiryIndexKey,
  LAYOUT_MARKER,
  metadataKey,
  reservationDecisionKey,
  reservationFenceKey,
  reservationKey,
  reservationTransitionKey,
  reservationUpdateKey,
  signalBlobAdapterFailure,
  signalRetainedBlobPanic,
  temporaryKey,
  type BlobBackend,
  type BlobSink,
} from "./backend";
import { BlobAdapterFailure } from "./errors";

export type ClassifiedLocalFileCause =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "missing" }
  | { readonly kind: "exists" }
  | { readonly kind: "not-directory" }
  | { readonly kind: "failure" };

type NodeFileReadableStream = ReturnType<Awaited<ReturnType<typeof fs.open>>["readableWebStream"]>;

export function normalizeNodeFileReadableStream(
  stream: NodeFileReadableStream,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const captured = await Result.tryPromise({
        try: async () => reader.read(),
        catch: classifyLocalFileCause,
      });
      const outcome = captured.match<
        | {
            readonly kind: "read";
            readonly result: Awaited<ReturnType<typeof reader.read>>;
          }
        | {
            readonly kind: "failure";
            readonly failure: ClassifiedLocalFileCause;
          }
      >({
        ok: (result) => ({ kind: "read", result }),
        err: (failure) => ({ kind: "failure", failure }),
      });
      if (outcome.kind === "failure") {
        controller.error(
          outcome.failure.kind === "panic"
            ? outcome.failure.panic
            : new Error("Local blob content stream failed"),
        );
        return;
      }
      if (outcome.result.done) {
        controller.close();
        return;
      }
      if (!(outcome.result.value instanceof Uint8Array)) {
        controller.error(new Error("Local blob content stream returned non-byte data"));
        return;
      }
      controller.enqueue(new Uint8Array(outcome.result.value));
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

export function classifyLocalFileCause(cause: unknown): ClassifiedLocalFileCause {
  if (Panic.is(cause)) return { kind: "panic", panic: cause };
  if (cause instanceof Error) {
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "EEXIST") return { kind: "exists" };
    if (code === "ENOTDIR") return { kind: "not-directory" };
  }
  return { kind: "failure" };
}

export class LocalBlobBackend implements BlobBackend {
  readonly kind = "local" as const;
  readonly #root: string;
  #rootDevice?: number;
  #rootInode?: number;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async initialize(input: {
    readonly createIfMissing: boolean;
  }): Promise<ResultType<void, BlobAdapterFailure>> {
    const initialized = await captureAdapterOperation({
      adapter: this.kind,
      operation: "initialize layout",
      run: async () => {
        if (input.createIfMissing) {
          const firstCreated = await fs.mkdir(this.#root, {
            recursive: true,
            mode: 0o700,
          });
          if (firstCreated !== undefined) {
            let created = path.resolve(firstCreated);
            while (true) {
              await this.#syncAbsoluteDirectory(path.dirname(created));
              if (created === this.#root) break;
              const [next] = path.relative(created, this.#root).split(path.sep);
              if (next === undefined || next === "") break;
              created = path.join(created, next);
            }
          }
        }
        const rootStats = await fs.lstat(this.#root);
        if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
          signalBlobAdapterFailure("Blob storage root must be a real directory");
        }
        this.#rootDevice = rootStats.dev;
        this.#rootInode = rootStats.ino;
        await fs.chmod(this.#root, 0o700);
        for (const directory of [
          "reservations",
          "temporary",
          "expiry",
          "content/durable",
          "content/expires",
        ]) {
          if (input.createIfMissing) await this.#ensureDirectory(directory);
          else await this.#assertDirectory(directory);
        }

        const markerPath = this.#safePath("layout.json");
        const markerExists = await Bun.file(markerPath).exists();
        if (markerExists) {
          const markerStats = await fs.lstat(markerPath);
          if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
            signalBlobAdapterFailure("Blob storage layout marker must be a regular file");
          }
          await fs.chmod(markerPath, 0o600);
        }
        if (!markerExists && input.createIfMissing)
          await this.#durableWrite("layout.json", LAYOUT_MARKER);
        if (!markerExists && !input.createIfMissing) {
          signalBlobAdapterFailure("Blob storage layout marker is absent");
        }
        const marker = markerExists ? await fs.readFile(markerPath, "utf8") : LAYOUT_MARKER;
        if (marker !== LAYOUT_MARKER) {
          signalBlobAdapterFailure("Unsupported blob storage layout marker");
        }
        await this.#cleanupAbandonedTemporaryObjects();
      },
    });
    return initialized;
  }

  async createReservation(
    objectId: string,
    serialized: string,
    expiresAt?: number,
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    const reserved = await this.#writeTextVerified(
      reservationKey(objectId),
      serialized,
      "create upload reservation",
    );
    if (expiresAt === undefined) return reserved;
    const reservationFailure = reserved.match<BlobAdapterFailure | null>({
      ok: () => null,
      err: (failure) => failure,
    });
    if (reservationFailure !== null) return Result.err(reservationFailure);
    const indexed = await this.#writeTextVerified(
      expiryIndexKey(expiresAt, objectId),
      "",
      "create expiry index",
    );
    const indexFailure = indexed.match<BlobAdapterFailure | null>({
      ok: () => null,
      err: (failure) => failure,
    });
    if (indexFailure === null) return Result.ok(undefined);
    await this.deleteKeys([reservationKey(objectId)]);
    await this.deleteKeys([expiryIndexKey(expiresAt, objectId)]);
    return Result.err(indexFailure);
  }

  async readReservation(objectId: string): Promise<ResultType<string | null, BlobAdapterFailure>> {
    let effective: string | null = null;
    for (const key of [
      reservationFenceKey(objectId),
      reservationDecisionKey(objectId),
      reservationTransitionKey(objectId),
      reservationKey(objectId),
    ]) {
      const read = await this.#readOptional(key, "read upload reservation");
      const outcome = read.match<
        | { readonly kind: "value"; readonly value: string | null }
        | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
      >({
        ok: (value) => ({ kind: "value", value }),
        err: (failure) => ({ kind: "failure", failure }),
      });
      if (outcome.kind === "failure") return Result.err(outcome.failure);
      if (key === reservationKey(objectId)) {
        return Result.ok(outcome.value === null ? null : (effective ?? outcome.value));
      }
      effective ??= outcome.value;
    }
    return Result.ok(null);
  }

  async compareAndSwapReservation(
    objectId: string,
    expectedSerialized: string,
    serialized: string,
  ): Promise<ResultType<boolean, BlobAdapterFailure>> {
    const observed = await this.readReservation(objectId);
    const state = observed.match<
      | { readonly kind: "value"; readonly value: string | null }
      | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (state.kind === "failure") return Result.err(state.failure);
    if (state.value !== expectedSerialized) return Result.ok(false);
    const key = reservationUpdateKey(objectId, expectedSerialized);
    const published = await this.#writeTextExclusive(
      key,
      serialized,
      "compare and swap upload reservation",
    );
    const publishState = published.match<
      | { readonly kind: "published"; readonly published: boolean }
      | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
    >({
      ok: (value) => ({ kind: "published", published: value }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (publishState.kind === "failure") {
      const effective = await this.readReservation(objectId);
      return effective.match<ResultType<boolean, BlobAdapterFailure>>({
        ok: (value) => (value === serialized ? Result.ok(true) : Result.err(publishState.failure)),
        err: () => Result.err(publishState.failure),
      });
    }
    if (!publishState.published) return Result.ok(false);
    const effective = await this.readReservation(objectId);
    const deleted = effective.match({ ok: (value) => value === null, err: () => false });
    if (deleted) return (await this.deleteKeys([key])).map(() => false);
    return effective.map((value) => value === serialized);
  }

  async openSink(
    objectId: string,
    generation: string,
  ): Promise<ResultType<BlobSink, BlobAdapterFailure>> {
    const key = temporaryKey(objectId, generation);
    const opened = await captureAdapterOperation({
      adapter: this.kind,
      operation: "open temporary upload",
      run: async () => {
        await this.#assertSafeParent(key);
        return fs.open(this.#safePath(key), "wx", 0o600);
      },
    });
    return opened.map((handle) => {
      let settled = false;
      return {
        write: async (chunk) =>
          captureAdapterOperation({
            adapter: this.kind,
            operation: "write upload content",
            run: async () => {
              await handle.writeFile(chunk);
            },
          }),
        finish: async () => {
          if (settled) return Result.ok(undefined);
          const finished = await captureAdapterOperation({
            adapter: this.kind,
            operation: "sync upload content",
            run: async () => {
              await handle.sync();
              await handle.close();
            },
          });
          const complete = finished.match({ ok: () => true, err: () => false });
          if (complete) settled = true;
          return finished;
        },
        abort: async () => {
          if (settled) return Result.ok(undefined);
          settled = true;
          const closed = await captureAdapterOperation({
            adapter: this.kind,
            operation: "close aborted temporary upload",
            run: async () => handle.close(),
          });
          const removed = await captureAdapterOperation({
            adapter: this.kind,
            operation: "remove aborted temporary upload",
            run: async () => fs.rm(this.#safePath(key), { force: true }),
          });
          return closed.andThen(() => removed);
        },
      };
    });
  }

  async commitTemp(
    objectId: string,
    generation: string,
    contentKey: string,
    metadata: string,
    _expected: { readonly sha256: string; readonly byteLength: number },
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "commit upload content",
      run: async () => {
        await this.#ensureDirectory(path.posix.dirname(contentKey));
        await this.#assertSafeParent(contentKey);
        await fs.rename(
          this.#safePath(temporaryKey(objectId, generation)),
          this.#safePath(contentKey),
        );
        await fs.chmod(this.#safePath(contentKey), 0o600);
        await this.#syncDirectory(path.posix.dirname(contentKey));
        await this.#durableWrite(metadataKey(contentKey), metadata);
      },
    });
  }

  async openContent(
    contentKey: string,
  ): Promise<ResultType<ReadableStream<Uint8Array> | null, BlobAdapterFailure>> {
    const opened = await captureAdapterOperation({
      adapter: this.kind,
      operation: "open blob content",
      run: async () => {
        await this.#assertSafeParent(contentKey);
        const handle = await fs.open(
          this.#safePath(contentKey),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const stats = await handle.stat();
        if (!stats.isFile()) {
          await handle.close();
          signalBlobAdapterFailure("Blob storage object is not a regular file");
        }
        return normalizeNodeFileReadableStream(handle.readableWebStream({ autoClose: true }));
      },
    });
    const state = opened.match<
      | { readonly kind: "stream"; readonly stream: ReadableStream<Uint8Array> }
      | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
    >({
      ok: (stream) => ({ kind: "stream", stream }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (state.kind === "stream") return Result.ok(state.stream);
    const present = await this.#inspectOptionalFile(contentKey, "inspect blob content");
    return present.match<ResultType<ReadableStream<Uint8Array> | null, BlobAdapterFailure>>({
      ok: (exists) => (exists ? Result.err(state.failure) : Result.ok(null)),
      err: () => Result.err(state.failure),
    });
  }

  async readMetadata(contentKey: string): Promise<ResultType<string | null, BlobAdapterFailure>> {
    return this.#readOptional(metadataKey(contentKey), "read blob metadata");
  }

  async deleteKeys(keys: readonly string[]): Promise<ResultType<number, BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "delete blob objects",
      run: async () => {
        let deleted = 0;
        for (const key of keys) {
          await this.#assertSafeParent(key);
          const target = this.#safePath(key);
          if (await Bun.file(target).exists()) {
            const stats = await fs.lstat(target);
            if (stats.isSymbolicLink() || !stats.isFile()) {
              signalBlobAdapterFailure("Blob storage object is not a regular file");
            }
            await fs.rm(target);
            deleted += 1;
          }
        }
        return deleted;
      },
    });
  }

  async listExpiredReservationIds(
    now: number,
    limit: number,
  ): Promise<
    ResultType<{ readonly ids: readonly string[]; readonly remaining: boolean }, BlobAdapterFailure>
  > {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "list expired upload reservations",
      run: async () => {
        await this.#assertSafeParent("expiry/item");
        const partitions = await fs.readdir(this.#safePath("expiry"), {
          withFileTypes: true,
        });
        const eligiblePartitions = partitions
          .filter(
            (entry) =>
              entry.isDirectory() && /^\d{16}$/u.test(entry.name) && Number(entry.name) <= now,
          )
          .map((entry) => entry.name)
          .sort();
        const ids: string[] = [];
        for (const partition of eligiblePartitions) {
          await this.#assertSafeParent(`expiry/${partition}/item`);
          const entries = await fs.readdir(this.#safePath(`expiry/${partition}`), {
            withFileTypes: true,
          });
          for (const entry of entries) {
            if (entry.isFile() && /^b1_[0-9a-f]{32}$/u.test(entry.name)) {
              ids.push(entry.name);
            }
            if (ids.length > limit) break;
          }
          if (ids.length > limit) break;
        }
        return { ids: ids.slice(0, limit), remaining: ids.length > limit };
      },
    });
  }

  async #readOptional(
    key: string,
    operation: string,
  ): Promise<ResultType<string | null, BlobAdapterFailure>> {
    const bytes = await this.#readOptionalBytes(key, operation);
    return bytes.map((value) => (value === null ? null : new TextDecoder().decode(value)));
  }

  async #writeTextVerified(
    key: string,
    value: string,
    operation: string,
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    const written = await captureAdapterOperation({
      adapter: this.kind,
      operation,
      run: async () => this.#durableWrite(key, value),
    });
    const state = written.match<
      | { readonly complete: true }
      | { readonly complete: false; readonly failure: BlobAdapterFailure }
    >({
      ok: () => ({ complete: true }),
      err: (failure) => ({ complete: false, failure }),
    });
    if (state.complete) return Result.ok(undefined);
    const inspected = await this.#readOptional(key, `inspect ambiguous ${operation}`);
    return inspected.match<ResultType<void, BlobAdapterFailure>>({
      ok: (stored) => (stored === value ? Result.ok(undefined) : Result.err(state.failure)),
      err: () => Result.err(state.failure),
    });
  }

  async #writeTextExclusive(
    key: string,
    value: string,
    operation: string,
  ): Promise<ResultType<boolean, BlobAdapterFailure>> {
    const temporary = `${key}.${randomUUID()}.tmp`;
    const prepared = await captureAdapterOperation({
      adapter: this.kind,
      operation,
      run: async () => {
        await this.#ensureDirectory(path.posix.dirname(key));
        await this.#assertSafeParent(temporary);
        await this.#writeSyncedTemporary(temporary, value);
      },
    });
    const prepareFailure = prepared.match<BlobAdapterFailure | null>({
      ok: () => null,
      err: (failure) => failure,
    });
    if (prepareFailure !== null) return Result.err(prepareFailure);

    const linked = await Result.tryPromise<void, ClassifiedLocalFileCause>({
      try: async () => {
        await this.#assertSafeParent(key);
        await fs.link(this.#safePath(temporary), this.#safePath(key));
        await this.#syncDirectory(path.posix.dirname(key));
      },
      catch: classifyLocalFileCause,
    });
    const removed = await captureAdapterOperation({
      adapter: this.kind,
      operation: `clean up ${operation}`,
      run: async () => fs.rm(this.#safePath(temporary), { force: true }),
    });
    const cleanupFailure = removed.match<BlobAdapterFailure | null>({
      ok: () => null,
      err: (failure) => failure,
    });
    if (cleanupFailure !== null) return Result.err(cleanupFailure);
    return linked.match<() => ResultType<boolean, BlobAdapterFailure>>({
      ok: () => () => Result.ok(true),
      err: (failure) => () => {
        if (failure.kind === "panic") signalRetainedBlobPanic(failure.panic);
        if (failure.kind === "exists") return Result.ok(false);
        return Result.err(
          new BlobAdapterFailure({
            adapter: this.kind,
            kind: "io",
            operation,
            message: `local blob storage failed to ${operation}`,
          }),
        );
      },
    })();
  }

  async #readOptionalBytes(
    key: string,
    operation: string,
  ): Promise<ResultType<Uint8Array | null, BlobAdapterFailure>> {
    const captured = await Result.tryPromise<Uint8Array, ClassifiedLocalFileCause>({
      try: async () => {
        await this.#assertSafeParent(key);
        await using handle = await fs.open(
          this.#safePath(key),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const stats = await handle.stat();
        if (!stats.isFile()) {
          throw new Error("Blob storage object is not a regular file");
        }
        return new Uint8Array(await handle.readFile());
      },
      catch: classifyLocalFileCause,
    });
    return captured.match<() => ResultType<Uint8Array | null, BlobAdapterFailure>>({
      ok: (value) => () => Result.ok(value),
      err: (failure) => () => {
        if (failure.kind === "panic") signalRetainedBlobPanic(failure.panic);
        if (failure.kind === "missing") return Result.ok(null);
        return Result.err(
          new BlobAdapterFailure({
            adapter: this.kind,
            kind: "io",
            operation,
            message: `local blob storage failed to ${operation}`,
          }),
        );
      },
    })();
  }

  async #inspectOptionalFile(
    key: string,
    operation: string,
  ): Promise<ResultType<boolean, BlobAdapterFailure>> {
    const captured = await Result.tryPromise<boolean, ClassifiedLocalFileCause>({
      try: async () => {
        await this.#assertSafeParent(key);
        await using handle = await fs.open(
          this.#safePath(key),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const stats = await handle.stat();
        if (!stats.isFile()) {
          throw new Error("Blob storage object is not a regular file");
        }
        return true;
      },
      catch: classifyLocalFileCause,
    });
    return captured.match<() => ResultType<boolean, BlobAdapterFailure>>({
      ok: (value) => () => Result.ok(value),
      err: (failure) => () => {
        if (failure.kind === "panic") signalRetainedBlobPanic(failure.panic);
        if (failure.kind === "missing") return Result.ok(false);
        return Result.err(
          new BlobAdapterFailure({
            adapter: this.kind,
            kind: "io",
            operation,
            message: `local blob storage failed to ${operation}`,
          }),
        );
      },
    })();
  }

  async #durableWrite(key: string, value: string): Promise<void> {
    await this.#ensureDirectory(path.posix.dirname(key));
    await this.#assertSafeParent(key);
    const temporary = `${key}.${randomUUID()}.tmp`;
    await this.#assertSafeParent(temporary);
    await this.#writeSyncedTemporary(temporary, value);
    await fs.rename(this.#safePath(temporary), this.#safePath(key));
    await fs.chmod(this.#safePath(key), 0o600);
    await this.#syncDirectory(path.posix.dirname(key));
  }

  async #cleanupAbandonedTemporaryObjects(): Promise<void> {
    await this.#assertSafeParent("temporary/item");
    const entries = await fs.readdir(this.#safePath("temporary"), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const matched =
        /^(b1_[0-9a-f]{32})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
          entry.name,
        );
      if (matched === null) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        signalBlobAdapterFailure("Blob storage temporary object is unsafe");
      }
      const objectId = matched[1];
      const generation = matched[2];
      if (objectId === undefined || generation === undefined) continue;
      const reservation = this.#safePath(reservationKey(objectId));
      const reservationExists = await Bun.file(reservation).exists();
      const active =
        reservationExists &&
        (await fs.readFile(reservation, "utf8")).includes(
          `"generation":"${generation}","state":"pending"`,
        );
      if (!active) {
        await fs.rm(this.#safePath(`temporary/${entry.name}`));
        await this.#syncDirectory("temporary");
      }
    }
  }

  async #writeSyncedTemporary(key: string, value: string): Promise<void> {
    await using handle = await fs.open(this.#safePath(key), "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
  }

  async #syncDirectory(directory: string): Promise<void> {
    await using handle = await fs.open(this.#safePath(directory), "r");
    await handle.sync();
  }

  async #syncAbsoluteDirectory(directory: string): Promise<void> {
    await using handle = await fs.open(directory, "r");
    await handle.sync();
  }

  async #ensureDirectory(relativeDirectory: string): Promise<void> {
    await this.#assertRoot();
    if (relativeDirectory === ".") return;
    let current = "";
    for (const segment of relativeDirectory.split("/")) {
      current = current === "" ? segment : `${current}/${segment}`;
      const target = this.#safePath(current);
      const created = await fs.mkdir(target, { recursive: true, mode: 0o700 });
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        signalBlobAdapterFailure("Blob storage directory path is unsafe");
      }
      await fs.chmod(target, 0o700);
      if (created !== undefined) await this.#syncDirectory(path.posix.dirname(current));
    }
  }

  async #assertSafeParent(key: string): Promise<void> {
    await this.#assertRoot();
    const relativeParent = path.posix.dirname(key);
    if (relativeParent === ".") return;
    let current = "";
    for (const segment of relativeParent.split("/")) {
      current = current === "" ? segment : `${current}/${segment}`;
      const stats = await fs.lstat(this.#safePath(current));
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        signalBlobAdapterFailure("Blob storage path traverses an unsafe directory");
      }
    }
  }

  async #assertRoot(): Promise<void> {
    const stats = await fs.lstat(this.#root);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      this.#rootDevice === undefined ||
      this.#rootInode === undefined ||
      stats.dev !== this.#rootDevice ||
      stats.ino !== this.#rootInode
    ) {
      signalBlobAdapterFailure("Blob storage root identity changed");
    }
  }

  async #assertDirectory(key: string): Promise<void> {
    const stats = await fs.lstat(this.#safePath(key));
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      signalBlobAdapterFailure("Blob storage layout directory is unsafe");
    }
  }

  #safePath(key: string): string {
    if (key.startsWith("/") || key.includes("\\") || key.split("/").includes("..")) {
      signalBlobAdapterFailure("Unsafe blob storage key");
    }
    const target = path.resolve(this.#root, key);
    const relative = path.relative(this.#root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      signalBlobAdapterFailure("Blob storage key escapes its root");
    }
    return target;
  }
}
