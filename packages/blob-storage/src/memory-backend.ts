import { Result } from "better-result";

import {
  expiryIndexKey,
  reservationDecisionKey,
  reservationFenceKey,
  reservationKey,
  reservationTransitionKey,
  reservationUpdateKey,
  type BlobBackend,
  type BlobSink,
} from "./backend";
import type { BlobAdapterFailure } from "./errors";

export class MemoryBlobBackend implements BlobBackend {
  readonly kind = "memory" as const;
  readonly #values = new Map<string, Uint8Array>();
  #expiryCursor?: string;

  async initialize(): Promise<Result<void, BlobAdapterFailure>> {
    return Result.ok(undefined);
  }

  async createReservation(
    objectId: string,
    serialized: string,
    expiresAt?: number,
  ): Promise<Result<void, BlobAdapterFailure>> {
    this.#values.set(`reservations/${objectId}.json`, new TextEncoder().encode(serialized));
    if (expiresAt !== undefined) {
      this.#values.set(expiryIndexKey(expiresAt, objectId), new Uint8Array());
    }
    return Result.ok(undefined);
  }

  async readReservation(objectId: string): Promise<Result<string | null, BlobAdapterFailure>> {
    if (!this.#values.has(reservationKey(objectId))) return Result.ok(null);
    const value =
      this.#values.get(reservationFenceKey(objectId)) ??
      this.#values.get(reservationDecisionKey(objectId)) ??
      this.#values.get(reservationTransitionKey(objectId)) ??
      this.#values.get(reservationKey(objectId));
    return Result.ok(value === undefined ? null : new TextDecoder().decode(value));
  }

  async compareAndSwapReservation(
    objectId: string,
    expectedSerialized: string,
    serialized: string,
  ): Promise<Result<boolean, BlobAdapterFailure>> {
    const current = await this.readReservation(objectId);
    return current.map((observed) => {
      if (observed !== expectedSerialized || !this.#values.has(reservationKey(objectId)))
        return false;
      const key = reservationUpdateKey(objectId, expectedSerialized);
      if (this.#values.has(key)) return false;
      this.#values.set(key, new TextEncoder().encode(serialized));
      const effective =
        this.#values.get(reservationFenceKey(objectId)) ??
        this.#values.get(reservationDecisionKey(objectId)) ??
        this.#values.get(reservationTransitionKey(objectId)) ??
        this.#values.get(reservationKey(objectId));
      return effective !== undefined && new TextDecoder().decode(effective) === serialized;
    });
  }

  async openSink(
    objectId: string,
    generation: string,
  ): Promise<Result<BlobSink, BlobAdapterFailure>> {
    const key = `temporary/${objectId}.${generation}`;
    const chunks: Uint8Array[] = [];
    let aborted = false;
    return Result.ok({
      write: async (chunk) => {
        if (!aborted) chunks.push(chunk.slice());
        return Result.ok(undefined);
      },
      finish: async () => {
        if (!aborted) {
          const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
          const value = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            value.set(chunk, offset);
            offset += chunk.byteLength;
          }
          this.#values.set(key, value);
        }
        return Result.ok(undefined);
      },
      abort: async () => {
        aborted = true;
        chunks.length = 0;
        this.#values.delete(key);
        return Result.ok(undefined);
      },
    });
  }

  async commitTemp(
    objectId: string,
    generation: string,
    contentKey: string,
    metadata: string,
    _expected: { readonly sha256: string; readonly byteLength: number },
  ): Promise<Result<void, BlobAdapterFailure>> {
    const temporary = `temporary/${objectId}.${generation}`;
    const value = this.#values.get(temporary);
    if (value !== undefined) this.#values.set(contentKey, value);
    this.#values.set(`${contentKey}.json`, new TextEncoder().encode(metadata));
    this.#values.delete(temporary);
    return Result.ok(undefined);
  }

  async openContent(
    contentKey: string,
  ): Promise<Result<ReadableStream<Uint8Array> | null, BlobAdapterFailure>> {
    const value = this.#values.get(contentKey);
    if (value === undefined) return Result.ok(null);
    return Result.ok(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(value.slice());
          controller.close();
        },
      }),
    );
  }

  async readMetadata(contentKey: string): Promise<Result<string | null, BlobAdapterFailure>> {
    const value = this.#values.get(`${contentKey}.json`);
    return Result.ok(value === undefined ? null : new TextDecoder().decode(value));
  }

  async deleteKeys(keys: readonly string[]): Promise<Result<number, BlobAdapterFailure>> {
    let deleted = 0;
    for (const key of keys) {
      if (this.#values.delete(key)) deleted += 1;
    }
    return Result.ok(deleted);
  }

  async listExpiredReservationIds(
    now: number,
    limit: number,
  ): Promise<
    Result<{ readonly ids: readonly string[]; readonly remaining: boolean }, BlobAdapterFailure>
  > {
    const keys = [...this.#values.keys()]
      .filter((key) => key.startsWith("expiry/"))
      .filter((key) => this.#expiryCursor === undefined || key > this.#expiryCursor)
      .sort()
      .filter((key) => Number(key.split("/")[1]) <= now);
    const page = keys.slice(0, limit);
    const remaining = keys.length > limit;
    this.#expiryCursor = remaining ? page.at(-1) : undefined;
    return Result.ok({
      ids: page
        .map((key) => key.split("/")[2])
        .filter((objectId): objectId is string => objectId !== undefined),
      remaining,
    });
  }
}
