import { createHash, createHmac } from "node:crypto";

import { Result, type Result as ResultType } from "better-result";

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
  temporaryKey,
  type BlobBackend,
  type BlobSink,
} from "./backend";
import { BlobAdapterFailure } from "./errors";

export type S3BackendOptions = {
  readonly bucket: string;
  readonly prefix?: string;
  readonly endpoint?: string;
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly forcePathStyle?: boolean;
  readonly client?: Bun.S3Client;
  readonly clientFactory?: (options: Bun.S3Options) => Bun.S3Client;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export class S3BlobBackend implements BlobBackend {
  readonly kind = "s3" as const;
  readonly #client: Bun.S3Client;
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #prefix: string;
  readonly #bucket: string;
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #sessionToken?: string;
  #expiryCursor?: string;

  constructor(options: S3BackendOptions) {
    this.#prefix = normalizePrefix(options.prefix);
    this.#bucket = options.bucket;
    this.#region = options.region ?? "us-east-1";
    this.#accessKeyId = options.accessKeyId;
    this.#secretAccessKey = options.secretAccessKey;
    this.#sessionToken = options.sessionToken;
    const clientOptions: Bun.S3Options = {
      bucket: options.bucket,
      endpoint: options.endpoint,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      virtualHostedStyle:
        options.forcePathStyle === undefined ? undefined : !options.forcePathStyle,
    };
    this.#client =
      options.client ?? options.clientFactory?.(clientOptions) ?? new Bun.S3Client(clientOptions);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async initialize(input: {
    readonly createIfMissing: boolean;
  }): Promise<ResultType<void, BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "initialize layout",
      run: async () => {
        const marker = this.#key("layout.json");
        const exists = await this.#client.exists(marker);
        if (!exists && input.createIfMissing) {
          await this.#client.write(marker, LAYOUT_MARKER, {
            acl: "private",
            type: "application/json",
          });
        }
        if (!exists && !input.createIfMissing) {
          signalBlobAdapterFailure("Blob storage layout marker is absent");
        }
        const value = exists ? await this.#client.file(marker).text() : LAYOUT_MARKER;
        if (value !== LAYOUT_MARKER) {
          signalBlobAdapterFailure("Unsupported blob storage layout marker");
        }
      },
    });
  }

  async createReservation(
    objectId: string,
    serialized: string,
    expiresAt?: number,
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    const reserved = await this.#writeText(
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
    const indexed = await this.#writeText(
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
    const read = await this.#readTextObjects(
      [
        reservationFenceKey(objectId),
        reservationDecisionKey(objectId),
        reservationTransitionKey(objectId),
      ],
      "read upload reservation",
    );
    const base = await this.#readTextObjects([reservationKey(objectId)], "read base reservation");
    return Result.all([read, base]).map(([overlays, values]) => {
      const reservation = values[0] ?? null;
      if (reservation === null) return null;
      return overlays.find((value) => value !== null) ?? reservation;
    });
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
    if (publishState.kind === "failure") return Result.err(publishState.failure);
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
    const key = this.#key(temporaryKey(objectId, generation));
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "open temporary upload",
      run: async () => this.#client.file(key).writer({ acl: "private" }),
    }).then((opened) =>
      opened.map((writer) => {
        let settled = false;
        return {
          write: async (chunk) =>
            captureAdapterOperation({
              adapter: this.kind,
              operation: "write upload content",
              run: async () => {
                await writer.write(chunk);
              },
            }),
          finish: async () => {
            if (settled) return Result.ok(undefined);
            const finished = await captureAdapterOperation({
              adapter: this.kind,
              operation: "finish upload content",
              run: async () => {
                await writer.end();
              },
            });
            const complete = finished.match({
              ok: () => true,
              err: () => false,
            });
            if (complete) settled = true;
            return finished;
          },
          abort: async () => {
            if (settled) return Result.ok(undefined);
            settled = true;
            const ended = await captureAdapterOperation({
              adapter: this.kind,
              operation: "abort temporary upload",
              run: async () => {
                await writer.end(new Error("Blob upload interrupted"));
              },
            });
            const removed = await captureAdapterOperation({
              adapter: this.kind,
              operation: "remove aborted temporary upload",
              run: async () => this.#client.delete(key),
            });
            return ended.andThen(() => removed);
          },
        };
      }),
    );
  }

  async commitTemp(
    objectId: string,
    generation: string,
    contentKey: string,
    metadata: string,
    expected: { readonly sha256: string; readonly byteLength: number },
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    const temporary = this.#key(temporaryKey(objectId, generation));
    const destination = this.#key(contentKey);
    const metadataPath = this.#key(metadataKey(contentKey));
    const copiedOperation = captureAdapterOperation({
      adapter: this.kind,
      operation: "commit upload content",
      run: async () => {
        await this.#copyObject(temporary, destination);
      },
    });
    const metadataOperation = captureAdapterOperation({
      adapter: this.kind,
      operation: "commit upload metadata",
      run: async () => {
        await this.#client.write(metadataPath, metadata, {
          acl: "private",
          type: "application/json",
        });
      },
    });
    const [copied, metadataWritten] = await Promise.all([copiedOperation, metadataOperation]);
    const copyState = copied.match<
      | { readonly complete: true }
      | { readonly complete: false; readonly failure: BlobAdapterFailure }
    >({
      ok: () => ({ complete: true }),
      err: (failure) => ({ complete: false, failure }),
    });
    if (!copyState.complete) {
      const inspected = await this.#inspectAmbiguousContent(destination, expected);
      const recovered = inspected.match({
        ok: (valid) => valid,
        err: () => false,
      });
      if (!recovered) return Result.err(copyState.failure);
    }

    const metadataState = metadataWritten.match<
      | { readonly complete: true }
      | { readonly complete: false; readonly failure: BlobAdapterFailure }
    >({
      ok: () => ({ complete: true }),
      err: (failure) => ({ complete: false, failure }),
    });
    if (!metadataState.complete) {
      const inspected = await captureAdapterOperation({
        adapter: this.kind,
        operation: "inspect ambiguous metadata write",
        run: async () =>
          (await this.#client.exists(metadataPath)) &&
          (await this.#client.file(metadataPath).text()) === metadata,
      });
      const recovered = inspected.match({
        ok: (valid) => valid,
        err: () => false,
      });
      if (!recovered) return Result.err(metadataState.failure);
    }

    return captureAdapterOperation({
      adapter: this.kind,
      operation: "remove committed temporary upload",
      run: async () => {
        await this.#client.delete(temporary);
      },
    });
  }

  async openContent(
    contentKey: string,
  ): Promise<ResultType<ReadableStream<Uint8Array> | null, BlobAdapterFailure>> {
    const key = this.#key(contentKey);
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "open blob content",
      run: async () => {
        if (!(await this.#client.exists(key))) return null;
        await this.#client.stat(key);
        return this.#client.file(key).stream();
      },
    });
  }

  async readMetadata(contentKey: string): Promise<ResultType<string | null, BlobAdapterFailure>> {
    const key = this.#key(metadataKey(contentKey));
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "read blob metadata",
      run: async () => {
        if (!(await this.#client.exists(key))) return null;
        return this.#client.file(key).text();
      },
    });
  }

  async deleteKeys(keys: readonly string[]): Promise<ResultType<number, BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "delete blob objects",
      run: async () => {
        let deleted = 0;
        for (const key of keys) {
          const fullKey = this.#key(key);
          if (await this.#client.exists(fullKey)) {
            await this.#client.delete(fullKey);
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
        // Reserve one S3 list slot to distinguish another expired item from a future-only tail.
        const pageLimit = Math.min(999, limit);
        const prefix = this.#key("expiry/");
        const eligible: string[] = [];
        let startAfter = this.#expiryCursor;
        while (eligible.length <= pageLimit) {
          const response = await this.#client.list({
            prefix,
            maxKeys: pageLimit + 1 - eligible.length,
            startAfter,
          });
          const contents = response.contents ?? [];
          if (contents.length === 0) break;
          let reachedFuture = false;
          for (const { key } of contents) {
            const [partition] = key.slice(prefix.length).split("/");
            if (partition === undefined || !(Number(partition) <= now)) {
              reachedFuture = true;
              break;
            }
            eligible.push(key);
          }
          if (reachedFuture || response.isTruncated !== true) break;
          const next = contents.at(-1)?.key;
          if (next === undefined || (startAfter !== undefined && next <= startAfter)) {
            signalBlobAdapterFailure("S3 expiry listing did not advance");
          }
          startAfter = next;
        }
        const page = eligible.slice(0, pageLimit);
        const remaining = eligible.length > pageLimit;
        this.#expiryCursor = remaining ? page.at(-1) : undefined;
        return {
          ids: page
            .map((key) => key.slice(prefix.length).split("/")[1])
            .filter((objectId): objectId is string => objectId !== undefined),
          remaining,
        };
      },
    });
  }

  async #writeText(
    key: string,
    serialized: string,
    operation: string,
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    const fullKey = this.#key(key);
    const written = await captureAdapterOperation({
      adapter: this.kind,
      operation,
      run: async () => {
        await this.#client.write(fullKey, serialized, {
          acl: "private",
          type: "application/json",
        });
      },
    });
    const state = written.match<
      | { readonly complete: true }
      | { readonly complete: false; readonly failure: BlobAdapterFailure }
    >({
      ok: () => ({ complete: true }),
      err: (failure) => ({ complete: false, failure }),
    });
    if (state.complete) return Result.ok(undefined);
    const inspected = await captureAdapterOperation({
      adapter: this.kind,
      operation: `inspect ambiguous ${operation}`,
      run: async () =>
        (await this.#client.exists(fullKey)) &&
        (await this.#client.file(fullKey).text()) === serialized,
    });
    return inspected.match<ResultType<void, BlobAdapterFailure>>({
      ok: (matches) => (matches ? Result.ok(undefined) : Result.err(state.failure)),
      err: () => Result.err(state.failure),
    });
  }

  async #readTextObjects(
    keys: readonly string[],
    operation: string,
  ): Promise<ResultType<readonly (string | null)[], BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation,
      run: async () =>
        Promise.all(
          keys.map(async (key) => {
            const response = await this.#fetch(
              this.#client.presign(this.#key(key), {
                method: "GET",
                expiresIn: 60,
              }),
            );
            if (response.status === 404) return null;
            if (!response.ok) signalBlobAdapterFailure(`S3 request returned ${response.status}`);
            return response.text();
          }),
        ),
    });
  }

  async #copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    const destination = new URL(
      this.#client.presign(destinationKey, {
        method: "PUT",
        expiresIn: 60,
        acl: "private",
      }),
    );
    destination.search = "";
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update("").digest("hex");
    const copySource = `/${encodeS3Path(this.#bucket)}/${encodeS3Path(sourceKey)}`;
    const signedHeaders = new Map<string, string>([
      ["host", destination.host],
      ["x-amz-acl", "private"],
      ["x-amz-content-sha256", payloadHash],
      ["x-amz-copy-source", copySource],
      ["x-amz-date", amzDate],
      ...(this.#sessionToken === undefined
        ? []
        : ([["x-amz-security-token", this.#sessionToken]] as const)),
    ]);
    const canonicalHeaderNames = [...signedHeaders.keys()].sort();
    const canonicalHeaders = canonicalHeaderNames
      .map((name) => `${name}:${signedHeaders.get(name)?.trim()}\n`)
      .join("");
    const signedHeaderNames = canonicalHeaderNames.join(";");
    const canonicalRequest = [
      "PUT",
      destination.pathname,
      "",
      canonicalHeaders,
      signedHeaderNames,
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.#region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const dateKey = hmacSha256(`AWS4${this.#secretAccessKey}`, date);
    const regionKey = hmacSha256(dateKey, this.#region);
    const serviceKey = hmacSha256(regionKey, "s3");
    const signingKey = hmacSha256(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const response = await this.#fetch(destination, {
      method: "PUT",
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
        ...Object.fromEntries([...signedHeaders].filter(([name]) => name !== "host")),
      },
    });
    const responseText = await response.text();
    if (!response.ok || responseText.includes("<Error>")) {
      signalBlobAdapterFailure(`S3 copy request returned ${response.status}`);
    }
  }

  async #writeTextExclusive(
    key: string,
    serialized: string,
    operation: string,
  ): Promise<ResultType<boolean, BlobAdapterFailure>> {
    const fullKey = this.#key(key);
    const written = await captureAdapterOperation({
      adapter: this.kind,
      operation,
      run: async () => {
        const response = await this.#fetch(
          this.#client.presign(fullKey, {
            method: "PUT",
            expiresIn: 60,
            acl: "private",
            type: "application/json",
          }),
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "if-none-match": "*",
              "x-amz-acl": "private",
            },
            body: serialized,
          },
        );
        return { ok: response.ok, status: response.status };
      },
    });
    const state = written.match<
      | {
          readonly kind: "response";
          readonly ok: boolean;
          readonly status: number;
        }
      | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
    >({
      ok: (response) => ({ kind: "response", ...response }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (state.kind === "response" && state.ok) return Result.ok(true);
    if (state.kind === "response" && state.status === 412) return Result.ok(false);

    const inspected = await captureAdapterOperation({
      adapter: this.kind,
      operation: `inspect ambiguous ${operation}`,
      run: async () =>
        (await this.#client.exists(fullKey)) &&
        (await this.#client.file(fullKey).text()) === serialized,
    });
    return inspected.match<ResultType<boolean, BlobAdapterFailure>>({
      ok: (matches) =>
        matches
          ? Result.ok(true)
          : Result.err(
              state.kind === "failure"
                ? state.failure
                : new BlobAdapterFailure({
                    adapter: this.kind,
                    kind: "io",
                    operation,
                    message: `s3 blob storage failed to ${operation}`,
                  }),
            ),
      err: (failure) => Result.err(state.kind === "failure" ? state.failure : failure),
    });
  }

  async #inspectAmbiguousContent(
    key: string,
    expected: { readonly sha256: string; readonly byteLength: number },
  ): Promise<ResultType<boolean, BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "inspect ambiguous content write",
      run: async () => {
        if (!(await this.#client.exists(key))) return false;
        const bytes = new Uint8Array(await this.#client.file(key).arrayBuffer());
        return (
          bytes.byteLength === expected.byteLength &&
          createHash("sha256").update(bytes).digest("hex") === expected.sha256
        );
      },
    });
  }

  #key(key: string): string {
    return this.#prefix === "" ? key : `${this.#prefix}/${key}`;
  }
}

function normalizePrefix(prefix: string | undefined): string {
  return (prefix ?? "").replace(/^\/+|\/+$/gu, "");
}

function encodeS3Path(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/gu, percentEncodeCharacter))
    .join("/");
}

function percentEncodeCharacter(character: string): string {
  return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
}

function hmacSha256(key: string | Uint8Array, value: string): Uint8Array {
  return createHmac("sha256", key).update(value).digest();
}
